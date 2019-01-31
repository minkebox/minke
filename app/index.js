#! /usr/bin/node

const FS = require('fs');
const Koa = require('koa');
const Router = require('koa-router');
const Websockify = require('koa-websocket');
const Docker = require('dockerode');

global.DEBUG = !!process.env.DEBUG;

const Pages = require('./pages/pages');
const MinkeApp = require('./MinkeApp');


const App = Websockify(new Koa());
global.docker = new Docker({socketPath: '/var/run/docker.sock'});

App.on('error', (err) => {
  console.log(err);
});

const root = Router();
const wsroot = Router();

Pages(root, wsroot);

App.use(root.middleware());
App.ws.use(wsroot.middleware());
App.ws.use(async (ctx, next) => {
  await next(ctx);
  if (ctx.websocket.listenerCount('message') === 0) {
    ctx.websocket.close();
  }
});
App.listen(8080);

(async function() {
  await MinkeApp.startApps(App);
})();

process.on('SIGINT', async () => {
  await MinkeApp.shutdown();
  process.exit();
});
process.on('SIGTERM', async () => {
  await MinkeApp.shutdown();
  process.exit();
});
