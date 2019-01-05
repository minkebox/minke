#! /usr/bin/node

const FS = require('fs');
const Koa = require('koa');
const Router = require('koa-router');
const Websockify = require('koa-websocket');
const Docker = require('dockerode');

const MainPage = require('./MainPage');
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

root.get('/script.js', async (ctx) => {
  ctx.body = FS.readFileSync(`${__dirname}/script/script.js`, { encoding: 'utf8' });
  ctx.type = 'text/javascript';
});
root.get('/style.css', async (ctx) => {
  ctx.body = FS.readFileSync(`${__dirname}/css/style.css`, { encoding: 'utf8' });
  ctx.type = 'text/css';
});

(async function() {
  await MinkeApp.startApps(App);
  //await (await (await new MinkeApp().createFromConfig({ name: 'proxy', style: 'host', image: 'timwilkinson/dnsproxy' })).start()).save();
  //await (await (await new MinkeApp().createFromConfig({ name: 'wsdemo', style: 'hidden', image: 'timwilkinson/websocketdemo' })).start()).save();
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
