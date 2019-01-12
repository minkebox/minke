const fetch = require('node-fetch');
const Router = require('koa-router');
const WebSocket = require('ws');


function Forward(args) {
  this._prefix = args.prefix;
  const target = `${args.port === 443 ? 'https' : 'http'}://${args.IP4Address || 'localhost'}:${args.port || 80}${args.path || ''}/`;
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
          if (key !== 'host') {
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
        ctx.response.set(key, headers[key]);
      }
    }
  });
  const wstarget = `${args.port === 443 ? 'wss' : 'ws'}://${args.IP4Address || 'localhost'}:${args.port || 80}${args.path || ''}/`;
  this._wsrouter = Router({
    prefix: args.prefix
  });
  this._wsrouter.all('/:path*', async (ctx) => {
    const client = new WebSocket(`${wstarget}${ctx.params.path || ''}`);
    client.on('message', (msg) => {
      ctx.websocket.send(msg);
    });
    ctx.websocket.on('message', (msg) => {
      client.send(msg);
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

const HTTPForward = {

  createForward: function(args) {
    const f = new Forward(args);
    return {
      url: f._prefix,
      http: f._router.middleware(),
      ws: f._wsrouter.middleware()
    };
  }

}

module.exports = HTTPForward;
