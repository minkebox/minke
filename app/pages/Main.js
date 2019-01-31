const FS = require('fs');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');


function genApp(app) {
  return {
    _id: app._id,
    name: app._name,
    online: app._online,
    features: app._features,
    link: app._forward && app._forward.url,
    networks: {
      primary: app._features.vpn ? 'none' : app._networks.primary,
      secondary: app._networks.secondary
    }
  }
}

let mainTemplate;
let remoteAppTemplate;
function registerTemplates() {
  const partials = [
    'App',
    'Hamburger'
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
  const apps = MinkeApp.getApps().map(app => genApp(app));
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

  function updateNetworkConfig(status) {
    const html = Handlebars.compile('{{> App}}')(Object.assign(genApp(status.app), { allnetworks: MinkeApp.getNetworks() }));
    send({
      type: 'html.update',
      selector: `.network-home .application-${status.app._id}`,
      html: html
    });
    delete oldStatus[status.app._id];
    delete onlines[status.app._id];
  }

  function updateOnline(status) {
    if (status.online !== onlines[status.app._id]) {
      updateNetworkConfig(status);
      onlines[status.app._id] = status.online;
    }
  }

  function updateStatus(status) {
    const html = status.data;
    if (html != oldStatus[status.app._id]) {
      oldStatus[status.app._id] = html;
      send({
        type: 'html.update',
        selector: `.application-${status.app._id} .status`,
        html: html
      });
    }
  }

  function updateNetworkStatus(status) {
    const networks = MinkeApp.getNetworks();
    const app = status.app;
    const services = status.data;
    const remoteapps = [];
    for (let name in services) {
      services[name].forEach((service) => {
        const target = service.target.replace(/minke-(.*).local/, '$1');
        const localapp = apps.find(app => app._name === target);
        // Filter out any apps which may really be local.
        if (!localapp || !(localapp._networks.primary == app._name || localapp._networks.secondary == app._name))
        remoteapps.push({
          name: target,
          network: app._name
        });
      });
    }
    const html = remoteAppTemplate({ apps: remoteapps, networks: networks });
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
    app.on('update.online', updateOnline);
    app.on('update.status', updateStatus);
    app.on('update.network.status', updateNetworkStatus);
    app.on('update.network.config', updateNetworkConfig);
  }

  function offline(app) {
    app.off('update.online', updateOnline);
    app.off('update.status', updateStatus);
    app.off('update.network.status', updateNetworkStatus);
    app.off('update.network.config', updateNetworkConfig);
  }

  function createApp(status) {
    const html = Handlebars.compile('<tr class="application-{{_id}}">{{> App}}</tr>')(Object.assign(genApp(status.app), { allnetworks: MinkeApp.getNetworks() }));
    send({
      type: 'html.append',
      selector: `.network-home.localapps`,
      html: html
    });
    online(status.app);
    apps = MinkeApp.getApps();
  }

  function removeApp(status) {
    send({
      type: 'html.remove',
      selector: `.network-home.localapps .application-${status.app._id}`
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
