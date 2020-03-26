const url = require('url');
const Koa = require('koa');
const KoaRouter = require('koa-router');
const KoaProxy = require('koa-proxy');

function makeProxy(target) {
  const app = new Koa();
  app.use(async (ctx, next) => {
    await next();
    ctx.remove('Content-Security-Policy');
    ctx.remove('X-Frame-Options');
    ctx.set('X-MinkeBox-Proxy', 'true');
  });
  app.use(KoaProxy({
    host: target.origin
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
      http: f._router.middleware(),
    };
  },

  createEmbed: function(args) {
    const f = new Redirect(args);
    return {
      url: f._prefix,
      http: f._router.middleware(),
    };
  }

}

module.exports = HTTP;
