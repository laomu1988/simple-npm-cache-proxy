'use strict';
global.Promise = require('bluebird');
var logger = require('bunyan-hub-logger');
logger.replaceDebug('simple-npm-cache-proxy');
var http = require('http');
http.globalAgent.maxSockets = Infinity;
var url = require('url');
var path = require('path');
var fs = require('fs');
var _ = require('lodash');
var config = require('config');
var co = require('co');
var superagent = require('superagent');
var mkdirp = require('mkdirp');
var concat = require('concat-stream');
var shp = require('simple-http-proxy');
var db = require('level-sublevel')(require('levelup')(config.db.path, xtend(config.db.config, {
    valueEncoding: 'json'
})));
var dbCache = db.sublevel('cache');
var dbCacheJson = dbCache.sublevel('json');
var log = logger({
    app: 'simple-npm-cache-proxy',
    name: 'server',
    serializers: {
        response: logger.stdSerializers.res
    },
});
var Schedule = require('level-schedule');
var dbSchedule = db.sublevel('schedule');

promisifyEachAll([db, dbCache, dbCacheJson, dbSchedule]);

function promisifyEachAll(arr) {
    arr.forEach(Promise.promisifyAll);
}

function replaceBodyRegistry(body) {
    return body.replace(config.replaceHost[0], config.replaceHost[1]);
}

function xtend() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift({});
    return _.assign.apply(_, args);
}

var schedule = Schedule(dbSchedule);
/*
 * payload: {
 *   url,
 *   etag,
 *   registry: public | private
 * }
 */
schedule.job('update', function(payload, done) {
    log.trace({
        job: 'update',
        payload: payload,
    });
    var registryUrl, registryHost;
    if (Array.isArray(config.registry[payload.registry])) {
        registryUrl = config.registry[payload.registry][0];
        registryHost = config.registry[payload.registry][1];
    } else {
        registryUrl = config.registry[payload.registry];
        registryHost = url.parse(config.registry[payload.registry]).host;
    }
    superagent.get(registryUrl + payload.url)
        .set('host', registryHost)
        .set('if-none-match', payload.etag)
        .end(co.wrap(function * (err, r) {
            log.trace({
                job: 'update',
                payload: payload,
                err: err,
                response: r,
            });
            if (err || r.statusCode !== 200 || !r.headers.etag) {
                schedule.run('update', payload, Date.now() + 8 * 60 * 1000 + Math.random() * 4);
                done();
                return;
            }
            var headers = r.headers;
            if (r.text && headers.etag && headers.etag !== payload.etag) {
                var body = replaceBodyRegistry(r.text);
                try {
                    body = JSON.stringify(JSON.parse(body));
                } catch (e) {
                    if (!e) {
                        var cacheObject = {
                            statusCode: r.statusCode,
                            headers: xtend(pickHeaders(r.headers), {
                                'content-length': Buffer.byteLength(body)
                            }),
                            etag: r.headers.etag,
                            body: body,
                        };
                        log.info({
                            updated: true,
                            cacheObject: cacheObject,
                        });
                        yield dbCacheJson.putAsync(payload.url, cacheObject);
                    }
                }
            }
            schedule.run('update', xtend(payload, {
                etag: r.headers.etag,
            }), Date.now() + 8 * 60 * 1000 + Math.random() * 4);
            done();
        }));
});
var st = require('st');
var mount = st({
    path: config.tarballCacheDir,
    cache: { // specify cache:false to turn off caching entirely 
        fd: {
            max: 1000, // number of fd's to hang on to 
            maxAge: 1000 * 60 * 60, // amount of ms before fd's expire 
        },

        stat: false,

        content: {
            max: 1024 * 1024 * 64, // how much memory to use on caching contents 
            maxAge: 1000 * 60 * 10, // how long to cache contents for 
            // if `false` does not set cache control headers 
            cacheControl: 'public, max-age=600' // to set an explicit cache-control 
            // header value 
        },
    },
    index: false, // return 404's for directories 
    passthrough: true, // calls next/returns instead of returning a 404 error 
});

function pickHeaders(headers) {
    return _.pick(headers, [
        'etag',
        'content-type',
        'content-length',
    ]);
}

var cachedRequest = {};
var proxy = co.wrap(function * (registry, req, res) {
    var crkey = registry + '|' + req.url;
    if (config.cache[registry] && req.method === 'GET' && !req.url.match(/^\/-\//)) {
        var cache = yield dbCacheJson.getAsync(req.url).catch(function(err) {
            return false;
        })
        if (cache) {
            log.debug({
                req: req,
                cachedObject: cache
            });
            if ('if-none-match' in req.headers && req.headers['if-none-match'] === cache.etag) {
                cache.headers['content-length'] = 0;
                return {
                    statusCode: 304,
                    headers: cache.headers,
                    body: new Buffer(0),
                };
            }
            return cache;
        }
        var cr;
        if ((cr = cachedRequest[crkey])) {
            return cr;
        }
    }
    if ('if-none-match' in req.headers) { // make sure upstream return 200 instead of 304
        delete req.headers['if-none-match'];
    }
    if ('accept-encoding' in req.headers) { // remove gzip, get raw text body
        req.headers['accept-encoding'] = 'identity';
    }
    var registryUrl, registryHost;
    if (Array.isArray(config.registry[registry])) {
        registryUrl = config.registry[registry][0];
        registryHost = config.registry[registry][1];
    } else {
        registryUrl = config.registry[registry];
        registryHost = url.parse(config.registry[registry]).host;
    }
    req.headers.host = registryHost;

    var rp = new Promise(function(resolve, reject) {
        var request, response;
        var concatStream = concat(function(body) {
            if (!response && request) response = request.res;
            var headers = response.headers;
            // cache tarball
            if (config.cache[registry] && req.method === 'GET' && !headers.location &&
                headers['content-type'] === 'application/octet-stream') {
                var filePath = path.resolve(config.tarballCacheDir, req.url.replace(/^\/+/, ''));
                mkdirp(path.dirname(filePath), function(err) {
                    if (err) log.error(err);
                    fs.writeFile(filePath, body, function(err) {
                        if (err) log.error(err);
                    });
                });
            }
            // cache json
            else if ((headers['content-type'] || '').match(/^application\/json/i)) {
                body = body.toString('utf8');
                log.debug({
                    req: req,
                    body: body,
                });
                body = replaceBodyRegistry(body);
                log.debug({
                    req: req,
                    headers: headers,
                    replacedBody: body,
                });
                headers = xtend(headers, {
                    'content-length': Buffer.byteLength(body)
                });
                if (config.cache[registry] && req.method === 'GET' && !req.url.match(/^\/-\//) && typeof headers['etag'] === 'string') {
                    try {
                        body = JSON.stringify(JSON.parse(body));
                    } catch (e) {
                        if (!e) {
                            dbCacheJson.put(req.url, {
                                statusCode: response.statusCode,
                                headers: headers,
                                body: body,
                                etag: headers.etag,
                            });
                        }
                    }
                    schedule.run('update', {
                        registry: registry,
                        url: req.url,
                        etag: headers.etag,
                    }, Date.now() + 8 * 60 * 1000 + Math.random() * 4);
                }
            }
            resolve({
                statusCode: response.statusCode,
                headers: pickHeaders(headers),
                body: body,
            });
        });
        if (['GET', 'HEAD'].indexOf(req.method) === -1) {
            shp(registryUrl, {
                timeout: false,
                onrequest: function(options, req) {
                    options.headers.host = registryHost;
                },
                onresponse: function(_response, res) {
                    response = _response;
                    response.pipe(concatStream);
                    return true;
                },
            })(req, res, reject);
        } else {
            request = superagent(req.method, registryUrl + req.url)
                .redirects(1)
                .set(req.headers);
            request.pipe(concatStream);
            request._callback = function(err) {
                if (err) return reject(err);
            };
        }
    });
    if (req.method === 'GET') {
        cachedRequest[crkey] = rp;
        rp.finally(function() {
            delete cachedRequest[crkey];
        });
    }
    return rp;
});

function routeProxy(req, res) {
    if (req.url.match(/^\/[^\/]+\/download\/.*\.tgz$/)) return proxy('taobao', req, res);
    if (req.url.match(/^\/-\/|@/) || req.method !== 'GET') return proxy('private', req, res);
    if (req.url.match(/^\/[^@\/]+$/)) return proxy('public', req, res);
    if (req.url.match(/^\/[^\/]+$/)) return proxy('private', req, res);
    return proxy('public', req, res);
}
var server = http.createServer();
server.on('request', function(req, res) {
    req.url = req.url.replace(/\/+/g, '/').replace(/\?.*$/g, '');
    res.status = function(code) {
        res.statusCode = code;
    };
    req.res = res;
    res.req = req;
    log.debug({
        req: req,
        res: res
    });
    if (req.url.match(/\/__flush__\//)) {
        var flushUrl = req.url.substring('/__flush__'.length);
        return co(function * () {
            yield dbCacheJson.delAsync(flushUrl);
            res.end('done');
        }).catch(resError);
    }
    ((['GET', 'HEAD'].indexOf(req.method) === -1) ?
        routeProxy(req, res) :
        new Promise(function(resolve, reject) {
            req.on('close', resolve);
            req.on('finish', resolve);
            mount(req, res, function() {
                resolve(routeProxy(req, res));
            });
        })
    ).then(function(cache) {
        res.writeHeader(cache.statusCode, cache.headers);
        res.end(cache.body);
    }).catch(resError);

    function resError(err) {
        console.log(err);
        if (err) log.error(err);
        if (err && !res.headersSent) {
            res.status(500);
            log.error(err);
            res.end('500 internal error.');
        }
    }
});

server.listen(config.server.port);
