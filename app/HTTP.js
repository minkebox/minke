const url = require('url');
const Koa = require('koa');
const KoaRouter = require('koa-router');
const KoaProxy = require('koa-proxy');

function makeProxy(target) {
  const app = new Koa();
  app.use(async (ctx, next) => {
    // We transform location redirects ourselves because the proxy doesn't handle this. The proxy will
    // do redirect internally but if we let that happen then redirects from /aaa to /aaa/ aren't seen
    // by the browser which can break some apps (e.g. PiHole).
    const requestOrigin = ctx.request.origin;
    await next();
    const location = ctx.response.get('location');
    if (location && location.indexOf(target.origin) === 0) {
      ctx.response.set('Location', `${requestOrigin}${location.substring(target.origin.length)}`);
    }
  });
  app.use(KoaProxy({
    host: target.origin,
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

function Proxy(args) {
  this._prefix = args.prefix;
  const target = new url.URL(args.url);
  this._router = KoaRouter({
    prefix: this._prefix
  });
  this._router.all('/', async (ctx) => {
    if (!this._proxy) {
      this._proxy = await makeProxy(target);
    }
    ctx.redirect(`http://${ctx.request.header.host}:${this._proxy.port}${target.pathname}`);
  });
  this.close = () => {
    if (this._proxy) {
      this._proxy.close();
    }
  }
}

function Redirect(args) {
  this._prefix = args.prefix;
  this._router = KoaRouter({
    prefix: this._prefix
  });
  this._router.all('/', async (ctx) => {
    ctx.redirect(args.url);
  });
}

const HTTP = {

  createProxy: function(args) {
    const f = new Proxy(args);
    return {
      url: f._prefix,
      http: f._router.middleware(),
      shutdown: () => f.shutdown()
    };
  },

  createNewTab: function(args) {
    const f = new Redirect(args);
    return {
      url: f._prefix,
      target: '_blank',
      http: f._router.middleware()
    };
  },

  createNewTabProxy: function(args) {
    const f = new Proxy(args);
    return {
      url: f._prefix,
      target: '_blank',
      http: f._router.middleware(),
      shutdown: () => f.shutdown()
    };
  },

  createUrl: function(args) {
    return {
      url: args.url
    };
  }

}

module.exports = HTTP;
