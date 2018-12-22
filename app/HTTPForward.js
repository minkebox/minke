const fetch = require('node-fetch');
const Router = require('koa-router');

function Forward(args) {
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
}

const HTTPForward = {

  createForward: function(args) {
    return new Forward(args)._router.middleware();
  }

}

module.exports = HTTPForward;
