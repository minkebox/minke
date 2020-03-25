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
//const DOHServer = require('./DOH');

const PORT = Config.WEB_PORT;

const App = Websockify(new Koa());
global.docker = new Docker({socketPath: '/var/run/docker.sock'});

App.on('error', (err) => {
  console.error(err);
});

App.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  ctx.set('Content-Security-Policy',
    "default-src 'self';" +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval';" +
    "style-src 'self' 'unsafe-inline';" +
    "img-src 'self' data:;" +
    `frame-src 'self' http://*.${MinkeApp.getLocalDomainName()} https://*.${MinkeApp.getLocalDomainName()};` +
    `connect-src 'self' ws://${ctx.headers.host};` +
    "font-src 'none';" +
    "object-src 'none';" +
    "media-src 'none';"
  );
  ctx.set('X-Response-Time', `${ms}ms`);
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

// DNS-over-HTTPS server
//DOHServer();

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
