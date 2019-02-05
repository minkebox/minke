const FS = require('fs');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');


function genApp(app, networks) {
  return {
    _id: app._id,
    name: app._name,
    status: app._status,
    link: app._forward && app._forward.url,
    ip: app._status === 'running' ? app._homeIP : null,
    network: !networks ? 0 : networks.findIndex((net) => {
      if (app._features.vpn) {
        return net.name === app._name;
      }
      else {
        return net.name === app._networks.primary;
      }
    })
  }
}

let mainTemplate;
let remoteAppTemplate;
function registerTemplates() {
  const partials = [
    'App',
    'Net'
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
  mainTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Main.html`, { encoding: 'utf8' }));
  remoteAppTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/RemoteApp.html`, { encoding: 'utf8' }));
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
  ctx.body = mainTemplate({ networks: networks, apps: apps });
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

  let apps = MinkeApp.getApps();

  function updateNetworkConfig(event) {
    const html = Handlebars.compile('{{> App}}')(genApp(event.app, MinkeApp.getNetworks()));
    send({
      type: 'html.replace',
      selector: `.application-${event.app._id}`,
      html: html
    });
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
        selector: `.application-${event.app._id} .status`,
        html: `<div onclick="frameElement.parentElement.onclick()">${html}</div>`
      });
    }
  }

  function updateServices(status) {
    const remoteapps = Object.values(status.services.reduce((acc, service) => {
      acc[service.name] = { name: service.target, description: service.txt.description || '', network: status.app._name };
      return acc;
    }, {}));
    const html = remoteAppTemplate({ apps: remoteapps, networks: MinkeApp.getNetworks() });
    if (oldNetworkStatus[status.app._id] != html) {
      oldNetworkStatus[status.app._id] = html;
      send({
        type: 'html.update',
        selector: `.network-${status.app._name}`,
        html: html
      });
    }
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
    const html = Handlebars.compile('{{> App}}')(genApp(status.app, MinkeApp.getNetworks()));
    send({
      type: 'html.append',
      selector: `#insertion-point`,
      html: html
    });
    online(status.app);
    apps = MinkeApp.getApps();
  }

  function removeApp(status) {
    send({
      type: 'html.remove',
      selector: `.application-${status.app._id}`
    });
    offline(status.app);
    apps = MinkeApp.getApps();
  }

  ctx.websocket.on('message', (msg) => {
    // ...
  });

  ctx.websocket.on('close', () => {
    apps.forEach(app => offline(app));
    MinkeApp.off('app.create', createApp);
    MinkeApp.off('app.remove', removeApp);
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  apps.forEach(app => online(app));
  MinkeApp.on('app.create', createApp);
  MinkeApp.on('app.remove', removeApp);
}

module.exports = {
  HTML: MainPageHTML,
  WS: MainPageWS
};
