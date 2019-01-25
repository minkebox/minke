#! /usr/bin/node

const FS = require('fs');
const Koa = require('koa');
const Router = require('koa-router');
const Websockify = require('koa-websocket');
const Docker = require('dockerode');

const MainPage = require('./pages/Main');
const SettingsPage = require('./pages/Settings');
const MinkeApp = require('./MinkeApp');

const App = Websockify(new Koa());
global.docker = new Docker({socketPath: '/var/run/docker.sock'});

App.on('error', (err) => {
  console.log(err);
});

const root = Router();
const wsroot = Router();

root.get('/', MainPage.HTML);
wsroot.get('/ws', MainPage.WS);
root.get('/settings/:id', SettingsPage.HTML);
wsroot.get('/settings/:id/ws', SettingsPage.WS);

root.get('/js/:script', async (ctx) => {
  ctx.body = FS.readFileSync(`${__dirname}/pages/script/${ctx.params.script}`, { encoding: 'utf8' });
  ctx.type = 'text/javascript';
});
root.get('/css/style.css', async (ctx) => {
  ctx.body = FS.readFileSync(`${__dirname}/pages/css/style.css`, { encoding: 'utf8' });
  ctx.type = 'text/css';
});
root.get('/img/:img', async (ctx) => {
  ctx.body = FS.readFileSync(`${__dirname}/pages/img/${ctx.params.img}`);
  ctx.type = 'image/png';
});

(async function() {
  await MinkeApp.startApps(App);
})();


App.use(root.middleware());
App.ws.use(wsroot.middleware());
App.ws.use(async (ctx, next) => {
  await next(ctx);
  if (ctx.websocket.listenerCount('message') === 0) {
    ctx.websocket.close();
  }
});
App.listen(8080);

process.on('SIGINT', async () => {
  await MinkeApp.shutdown();
  process.exit();
});
process.on('SIGTERM', async () => {
  await MinkeApp.shutdown();
  process.exit();
});
