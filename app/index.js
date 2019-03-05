#! /usr/bin/node

global.DEBUG = !!process.env.DEBUG;

const Koa = require('koa');
const Router = require('koa-router');
const Websockify = require('koa-websocket');
const CacheControl = require('koa-cache-control');
const Docker = require('dockerode');
const Pages = require('./pages/pages');
const MinkeApp = require('./MinkeApp');
const UPNP = require('./UPNP');


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
App.listen(80);

(async function() {
  await MinkeApp.startApps(App);
})();

process.on('uncaughtException', (e) => {
  console.error(e)   
});

process.on('SIGINT', async () => {
  await MinkeApp.shutdown();
  process.exit();
});
process.on('SIGTERM', async () => {
  await MinkeApp.shutdown();
  process.exit();
});
