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

MinkeApp.setApp(App);

(async function() {
  await MinkeApp({ name: 'speedtest', type: 'hidden', image: 'timwilkinson/docker-speedtest-analyser' });
  await MinkeApp({ name: 'proxy',     type: 'host',   image: 'timwilkinson/dnsproxy' });
  await MinkeApp({ name: 'wsdemo',    type: 'hidden', image: 'timwilkinson/websocketdemo' });
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
