#! /usr/bin/node

const Koa = require('koa');
const Router = require('koa-router');
const Websockify = require('koa-websocket');
const Docker = require('dockerode');

const MinkeApp = require('./MinkeApp');

const App = Websockify(new Koa());
global.docker = new Docker({socketPath: '/var/run/docker.sock'});

App.on('error', (err) => {
  console.log(err);
});

const root = Router();

root.get('/', async (ctx) => {
  ctx.body = 'Hello\n';
});


(async function() {
  await MinkeApp.startApps(App);
  //await (await (await new MinkeApp().createFromConfig({ name: 'proxy', style: 'host', image: 'timwilkinson/dnsproxy' })).start()).save();
  //await (await (await new MinkeApp().createFromConfig({ name: 'wsdemo', style: 'hidden', image: 'timwilkinson/websocketdemo' })).start()).save();
})();


App.use(root.middleware());
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
