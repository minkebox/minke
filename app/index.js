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
  //await MinkeApp({ name: 'speedtest', style: 'hidden', image: 'timwilkinson/docker-speedtest-analyser' });
  //await MinkeApp({ name: 'proxy',     style: 'host',   image: 'timwilkinson/dnsproxy' });
  //await MinkeApp({ name: 'wsdemo',    style: 'hidden', image: 'timwilkinson/websocketdemo' });
  //const a = await new MinkeApp().createFromConfig({ name: 'wsdemo2', style: 'hidden', image: 'timwilkinson/websocketdemo' });
  //console.log(a);
  //await a.start();
  //await a.save();
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
