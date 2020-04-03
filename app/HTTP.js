const URL = require('url');
const FS = require('fs');
const Koa = require('koa');
const KoaRouter = require('koa-router');
const KoaProxy = require('koa-proxy');

const TEMPORARY_REDIRECT = 307;
const INTERNAL_SERVER_ERROR = 500;

function makeProxy(to) {
  const app = new Koa();
  app.use(async (ctx, next) => {
    try {
      // We transform location redirects ourselves because the proxy doesn't handle this. The proxy will
      // do redirect internally but if we let that happen then redirects from /aaa to /aaa/ aren't seen
      // by the browser which can break some apps (e.g. PiHole).
      const requestOrigin = ctx.request.origin;
      await next();
      const location = ctx.response.get('location');
      if (location && location.indexOf(to) === 0) {
        ctx.response.set('Location', `${requestOrigin}${location.substring(to.length)}`);
      }
    }
    catch (e) {
      ctx.type = 'text/html';
      ctx.body = FS.readFileSync(`${__dirname}/pages/html/ProxyFail.html`);
    }
  });
  app.use(KoaProxy({
    host: to,
    jar: true, // Send cookies
    followRedirect: false, // Handle redirects by hand (see above))
    overrideResponseHeaders: {
      'X-MinkeBox-Proxy': 'true'
    },
    suppressResponseHeaders: [
      'content-security-policy',
      'x-frame-options'
    ]
  }));
  const server = app.listen();
  return new Promise(resolve => {
    server.on('listening', () => {
      resolve({
        port: server.address().port,
        close: () => {
          server.close();
        }
      });
    });
  });
}

function Proxy(app, from, to) {
  this._router = KoaRouter({
    prefix: from
  });
  this._router.all('(.*)', async (ctx) => {
    if (!app._webProxy) {
      app._webProxy = await makeProxy(to);
    }
    ctx.redirect(`http://${ctx.request.header.host}:${app._webProxy.port}${ctx.params[0] || ''}`);
    ctx.status = TEMPORARY_REDIRECT;
  });
}

function Redirect(from, url) {
  this._router = KoaRouter({
    prefix: from
  });
  this._router.all('/', async (ctx) => {
    ctx.redirect(url);
    ctx.status = TEMPORARY_REDIRECT;
  });
}

const HTTP = {

  createProxy: function(app, from, path, to) {
    const f = new Proxy(app, from, to);
    return {
      url: `${from}${path || ''}`.replace(/\/\//g,'/'),
      http: f._router.middleware()
    };
  },

  createNewTab: function(app, from, url) {
    const f = new Redirect(from, url);
    return {
      url: from,
      target: '_blank',
      http: f._router.middleware()
    };
  },

  createNewTabProxy: function(app, from, path, to) {
    const f = new Proxy(app, from, to);
    return {
      url: `${from}${path || ''}`.replace(/\/\//g,'/'),
      target: '_blank',
      http: f._router.middleware()
    };
  },

  createUrl: function(url) {
    return {
      url: url
    };
  }

}

module.exports = HTTP;
