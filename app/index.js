#! /usr/bin/node

global.DEBUG = !!process.env.DEBUG;

const Koa = require('koa');
const Router = require('koa-router');
const Websockify = require('koa-websocket');
const CacheControl = require('koa-cache-control');
const Docker = require('dockerode');
const Config = require('./Config');
const Pages = require('./pages/pages');
const MinkeApp = require('./MinkeApp');
const UPNP = require('./UPNP');

const PORT = Config.WEB_PORT;

const App = Websockify(new Koa());
global.docker = new Docker({socketPath: '/var/run/docker.sock'});

App.on('error', (err) => {
  console.log(err);
});

App.use(CacheControl({ noCache: true }));

const root = Router();
const wsroot = Router();

Pages.register(root, wsroot);
UPNP.register(root, wsroot);

App.use(root.middleware());
App.ws.use(wsroot.middleware());
App.ws.use(async (ctx, next) => {
  await next(ctx);
  if (ctx.websocket.listenerCount('message') === 0) {
    ctx.websocket.close();
  }
});

MinkeApp.startApps(App, { inherit: process.env.RESTART_REASON === 'restart' || process.env.RESTART_REASON === 'update', port: PORT });

const Redirect = new Koa();
Redirect.use(async ctx => {
  if (ctx.request.header['content-type'] === 'application/dns-message') {
    ctx.redirect(`https://${Config.DOH_SERVER_NAME}:${Config.DOH_SERVER_PORT}${Config.DOH_SERVER_PATH}`);
  }
  else {
    ctx.redirect(`http://${ctx.request.hostname}:${PORT}${ctx.request.path}`);
  }
});
Redirect.listen(80);

process.on('uncaughtException', (e) => {
  console.error(e)
});
process.on('SIGINT', async () => {
  await MinkeApp.shutdown({});
  process.exit();
});
process.on('SIGTERM', async () => {
  await MinkeApp.shutdown({});
  process.exit();
});
process.on('SIGUSR1', async() => {
  await MinkeApp.shutdown({ inherit: true });
  process.exit();
});
