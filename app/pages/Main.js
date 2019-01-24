const FS = require('fs');
const Handlebars = require('handlebars');
const MinkeApp = require('../MinkeApp');


function getNetworks() {
  return MinkeApp.getApps().reduce((acc, app) => {
    if (app._ip4.indexOf('vpn') !== -1) {
      acc.push({
        id: app._name,
        name: `vpn-${app._name}`
      });
    }
    return acc;
  }, [ { id: 'home', name: 'home' }]);
}

async function MainPageHTML(ctx) {

  const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Main.html`, { encoding: 'utf8' }));

  const networks = getNetworks();
  const apps = MinkeApp.getApps().reduce((acc, app) => {
    //if (app._ip4.indexOf('vpn') === -1) {
      acc.push({
        id: app._name,
        online: app._online,
        link: app._forward && app._forward.url,
        networks: networks.reduce((acc, network) => {
          if (app._ip4.indexOf(network.name) !== -1) {
            acc[network.name] = 'attached';
          }
          return acc;
        }, app._ip4.indexOf('vpn') === -1 ? {} : { [`vpn-${app._name}`]: 'attached' })
      });
    //}
    return acc;
  }, []);
  ctx.body = template({ networks: networks, apps: apps });
  ctx.type = 'text/html';
}

async function MainPageWS(ctx) {

  const ghostsTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Ghosts.html`, { encoding: 'utf8' }));

  const apps = MinkeApp.getApps();

  function updateOnline(status) {
    ctx.websocket.send(JSON.stringify({
      type: 'html.update',
      selector: `.application-${status.app._name} .ready`,
      html: status.online ? '<span class="online">running</span>' : '<span class="offline">stopped</span>'
    }));
  }

  function updateStatus(status) {
    try {
      ctx.websocket.send(JSON.stringify({
        type: 'html.update',
        selector: `.application-${status.app._name} .status`,
        html: status.data
      }));
    }
    catch (_) {
    }
  }

  const oldStatus = {};

  function updateNetworkStatus(status) {
    const networks = getNetworks();
    const apps = MinkeApp.getApps();
    const services = status.data;
    const ghosts = {};
    for (let name in services) {
      services[name].forEach((service) => {
        if (!ghosts[service.target]) {
          const id = service.target.replace(/minke-(.*).local/, "$1");
          if (apps.find(app => app._name == id && app._ip4.indexOf(`vpn-${status.app._name}`))) {
            ghosts[service.target] = {
              id: id,
              networks: { [`vpn-${status.app._name}`]: 'attached' }
            };
          }
        }
      });
    }
    const html = ghostsTemplate({ ghosts: Object.values(ghosts), networks: networks });
    if (oldStatus[status.app._name] != html) {
      oldStatus[status.app._name] = html;
      try {
        ctx.websocket.send(JSON.stringify({
          type: 'html.update',
          selector: `.network-${status.app._name} .ghosts`,
          html: html
        }));
      }
      catch (_) {
      }
    }
  }

  ctx.websocket.on('message', (msg) => {
    // ...
  });

  ctx.websocket.on('close', () => {
    apps.forEach((app) => {
      app.off('update.online', updateOnline);
      app.off('update.status', updateStatus);
      app.off('update.network.status', updateNetworkStatus);
    });
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  apps.forEach((app) => {
    app.on('update.online', updateOnline);
    app.on('update.status', updateStatus);
    app.on('update.network.status', updateNetworkStatus);
  });
}

module.exports = {
  HTML: MainPageHTML,
  WS: MainPageWS
};
