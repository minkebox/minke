const FS = require('fs');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');


function genApp(app, networks) {
  return {
    _id: app._id,
    name: app._name,
    status: app._status,
    ip: app._status === 'running' && !app._features.vpn ? app._homeIP : null,
    link: app._forward && app._forward.url,
    network: !networks ? 0 : app._networks.primary === 'host' ? 0 : networks.findIndex((net) => {
      if (app._features.vpn) {
        return net.name === app._name;
      }
      else {
        return net.name === app._networks.primary;
      }
    })
  }
}

function genAppStatus(acc, app, networks) {
  if (app._monitor.cmd) {
    acc.push({
      _id: app._id,
      name: app._name,
      header: app._monitor.header,
      link: app._forward && app._forward.url,
      running: app._status === 'running',
      network: !networks ? 0 : app._networks.primary === 'host' ? 0 : networks.findIndex((net) => {
        if (app._features.vpn) {
          return net.name === app._name;
        }
        else {
          return net.name === app._networks.primary;
        }
      })
    });
  }
  return acc;
}

let mainTemplate;
let remoteAppTemplate;
let appTemplate;
let appStatusTemplate;
let netTemplate;
let netsTemplate;
function registerTemplates() {
  const partials = [
    'App',
    'AppStatus',
    'Net'
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
  mainTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Main.html`, { encoding: 'utf8' }));
  remoteAppTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/RemoteApp.html`, { encoding: 'utf8' }));
  appTemplate = Handlebars.compile('{{> App}}');
  appStatusTemplate = Handlebars.compile('{{> AppStatus}}');
  netTemplate = Handlebars.compile('{{> Net}}');
  netsTemplate = Handlebars.compile('{{#each networks}}{{> Net}}{{/each}}');
}
if (!DEBUG) {
  registerTemplates();
}


async function MainPageHTML(ctx) {

  if (DEBUG) {
    registerTemplates();
  }

  const networks = MinkeApp.getNetworks();
  const apps = MinkeApp.getApps().map(app => genApp(app, networks));
  const statuses = MinkeApp.getApps().reduce((acc, app) => genAppStatus(acc, app, networks), []);
  ctx.body = mainTemplate({ adminMode: MinkeApp.adminMode, networks: networks, apps: apps, statuses: statuses });
  ctx.type = 'text/html';
}

async function MainPageWS(ctx) {

  function send(msg) {
    try {
      ctx.websocket.send(JSON.stringify(msg));
    }
    catch (_) {
    }
  }

  const oldStatus = {};
  const onlines = {};
  const oldNetworkStatus = {};
  const remoteApps = {};

  let apps = MinkeApp.getApps();

  function updateNetworkConfig(event) {
    const networks = MinkeApp.getNetworks();
    const html = appTemplate(genApp(event.app, networks));
    send({
      type: 'html.replace',
      selector: `.application-${event.app._id}`,
      html: html
    });
    const appstatus = genAppStatus([], event.app, networks);
    if (appstatus.length) {
      send({
        type: 'html.replace',
        selector: `.application-status-${event.app._id}`,
        html: appStatusTemplate(appstatus[0])
      });
    }
    delete oldStatus[event.app._id];
    delete onlines[event.app._id];
  }

  function updateStatus(event) {
    if (event.status !== onlines[event.app._id]) {
      updateNetworkConfig(event);
      onlines[event.app._id] = event.status;
    }
  }

  function updateMonitor(event) {
    const html = event.data;
    if (html !== oldStatus[event.app._id]) {
      oldStatus[event.app._id] = html;
      send({
        type: 'html.update',
        selector: `.application-status-${event.app._id} .status`,
        html: html
      });
    }
  }

  function updateServices(status) {
    const networks = MinkeApp.getNetworks();
    const oldApps = remoteApps[status.app._id] || {};
    const existApps = {};
    const newApps = {};
    status.services.forEach((service) => {
      if (service.name in oldApps) {
        existApps[service.name] = oldApps[service.name];
      }
      else {
        newApps[service.name] = { netid: status.app._id, name: service.target, network: networks.findIndex(net => net.name === status.app._name) };
        existApps[service.name] = newApps[service.name];
      }
      delete oldApps[service.name];
    });
    remoteApps[status.app._id] = existApps;

    for (let name in oldApps) {
      send({
        type: 'html.remove',
        selector: `.remote-application-${status.app._id}-${oldApps[name].name}`
      });
    }
    for (let name in newApps) {
      send({
        type: 'html.append',
        selector: '#app-insertion-point',
        html: remoteAppTemplate(newApps[name])
      });
    }
    send({
      type: 'html.update',
      selector: '#network-insertion-point',
      html: netsTemplate({ networks: networks })
    });
  }

  function online(app) {
    app.on('update.status', updateStatus);
    app.on('update.monitor', updateMonitor);
    app.on('update.services', updateServices);
    app.on('update.network.config', updateNetworkConfig);
  }

  function offline(app) {
    app.off('update.status', updateStatus);
    app.off('update.monitor', updateMonitor);
    app.off('update.services', updateServices);
    app.off('update.network.config', updateNetworkConfig);
  }

  function createApp(status) {
    const networks = MinkeApp.getNetworks();
    const html = appTemplate(genApp(status.app, networks));
    send({
      type: 'html.append',
      selector: `#app-insertion-point`,
      html: html
    });
    online(status.app);
    apps = MinkeApp.getApps();
    const appstatus = genAppStatus([], status.app, networks);
    if (appstatus.length) {
      send({
        type: 'html.append',
        selector: `#appstatus-insertion-point`,
        html: appStatusTemplate(appstatus[0])
      });
    }
  }

  function removeApp(status) {
    send({
      type: 'html.remove',
      selector: `.application-${status.app._id}`
    });
    send({
      type: 'html.remove',
      selector: `.application-status-${status.app._id}`
    });
    offline(status.app);
    apps = MinkeApp.getApps();
  }

  function createNet(status) {
    const html = netTemplate({ _id: status.network._id, name: status.network.name, index: MinkeApp.getNetworks().length - 1 });
    send({
      type: 'html.append',
      selector: `#network-insertion-point`,
      html: html
    });
  }

  function removeNet(status) {
    send({
      type: 'html.remove',
      selector: `.network-${status.network._id}`
    });
  }

  ctx.websocket.on('message', (msg) => {
    // ...
  });

  ctx.websocket.on('close', () => {
    apps.forEach(app => offline(app));
    MinkeApp.off('app.create', createApp);
    MinkeApp.off('app.remove', removeApp);
    MinkeApp.off('net.create', createNet);
    MinkeApp.off('net.remove', removeNet);
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  apps.forEach(app => online(app));
  MinkeApp.on('app.create', createApp);
  MinkeApp.on('app.remove', removeApp);
  MinkeApp.on('net.create', createNet);
  MinkeApp.on('net.remove', removeNet);
}

module.exports = {
  HTML: MainPageHTML,
  WS: MainPageWS
};
