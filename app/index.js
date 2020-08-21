#! /usr/bin/node

global.DEBUG = !!process.env.DEBUG;
global.SYSTEM = !!process.env.SYSTEM;

const Koa = require('koa');
const Router = require('koa-router');
const Websockify = require('koa-websocket');
const CacheControl = require('koa-cache-control');
const Docker = require('dockerode');
const Config = require('./Config');
const Events = require('./utils/Events');

// More listeners
EventEmitter.defaultMaxListeners = 50;

global.Root = new Events(); // System events

const Pages = require('./pages/pages');
const MinkeApp = require('./MinkeApp');
const MinkeSetup = require('./MinkeSetup');
const UPNP = require('./UPNP');

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
  const domainname = MinkeApp.getLocalDomainName();
  const domainsrc = domainname ? `http://*.${domainname} http://*.${domainname}:* https://*.${domainname}` : '';
  ctx.set('Content-Security-Policy',
    "default-src 'self';" +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval';" +
    "style-src 'self' 'unsafe-inline';" +
    "img-src 'self' data:;" +
    `frame-src ${domainsrc} http://${ctx.request.header.host}:* https://*.minkebox.net;` +
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

// MIGRATION - RESTART_REASON Remove May 26, 2020
const restart = process.env.RESTART_REASON || MinkeSetup.restartReason('exit');
MinkeApp.startApps(App, { inherit: restart === 'restart' || restart === 'update', port: PORT });

process.on('uncaughtException', (e) => {
  console.error(e)
});
process.on('SIGINT', async () => {
  await MinkeApp.getAppById('minke').systemRestart('halt');
});
process.on('SIGTERM', async () => {
  await MinkeApp.getAppById('minke').systemRestart('halt');
});
process.on('SIGUSR1', async() => {
  await MinkeApp.getAppById('minke').systemRestart('restart');
});
