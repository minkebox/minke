const fetch = require('node-fetch');
const Router = require('koa-router');
const WebSocket = require('ws');


function Forward(args) {
  this._prefix = args.prefix;
  const target = args.url;
  this._router = Router({
    prefix: args.prefix
  });
  this._router.all('/:path*', async (ctx) => {
    const request = ctx.request;
    if (!ctx.params.path && request.path.slice(-1) !== '/') {
      ctx.redirect(`${request.path}/${request.search}`);
    }
    else {
      const result = await fetch(`${target}${ctx.params.path || ''}`, {
        headers: Object.keys(request.headers).reduce((obj, key) => {
          if (key !== 'host' && !(key in obj)) {
            obj[key] = request.headers[key];
          }
          return obj;
        }, {}),
        method: request.method,
        body: request.body
      });
      ctx.response.status = result.status;
      ctx.response.body = await result.buffer();
      const headers = result.headers.raw();
      for (let key in headers) {
        switch (key.toLowerCase()) {
          case 'content-encoding':
          case 'content-length':
          case 'keep-alive':
            break;
          case 'connection':
            ctx.response.set('Connection', 'close');
            break;
          default:
            ctx.response.set(key, headers[key]);
            break;
        }
      }
    }
  });
  const wstarget = args.url.replace(/^http/, 'ws');
  this._wsrouter = Router({
    prefix: args.prefix
  });
  this._wsrouter.all('/:path*', async (ctx) => {
    const client = new WebSocket(`${wstarget}${ctx.params.path || ''}`);
    client.on('message', (msg) => {
      try {
        ctx.websocket.send(msg);
      }
      catch (_) {
      }
    });
    ctx.websocket.on('message', (msg) => {
      try {
        client.send(msg);
      }
      catch (_) {
      }
    });
    client.on('close', () => {
      ctx.websocket.close();
    });
    ctx.websocket.on('close', () => {
      client.close();
    });
    client.on('error', () => {
      ctx.websocket.close();
    });
    ctx.websocket.on('error', () => {
      client.close();
    });
  });
}

function Redirect(args) {
  this._prefix = args.prefix;
  this._router = Router({
    prefix: this._prefix
  });
  this._router.all('/', async (ctx) => {
    ctx.redirect(args.url);
  });
}

const HTTP = {

  createProxy: function(args) {
    const f = new Forward(args);
    return {
      url: f._prefix,
      http: f._router.middleware(),
      ws: f._wsrouter.middleware()
    };
  },

  createNewTab: function(args) {
    const f = new Redirect(args);
    return {
      url: f._prefix,
      target: '_blank',
      http: f._router.middleware(),
      ws: null
    };
  },

  createEmbed: function(args) {
    const f = new Redirect(args);
    return {
      url: f._prefix,
      http: f._router.middleware(),
      ws: null
    };
  }

}

module.exports = HTTP;
