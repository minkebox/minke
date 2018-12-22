#! /usr/bin/node

const Koa = require('koa');
const Router = require('koa-router');
const Docker = require('dockerode');

const MinkeApp = require('./MinkeApp');

const App = new Koa();
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
})();


App.use(root.middleware());
App.listen(8080);

process.on('SIGINT', async () => {
  await MinkeApp.shutdown();
  process.exit();
});
