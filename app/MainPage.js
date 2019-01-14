const FS = require('fs');
const Handlebars = require('handlebars');
const MinkeApp = require('./MinkeApp');

const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/MainPage.html`, { encoding: 'utf8' }));
const ghostsTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Ghosts.html`, { encoding: 'utf8' }));

async function MainPageHTML(ctx) {
  const apps = MinkeApp.getApps();
  const networks = apps.reduce((acc, app) => {
    if (app._ip4.indexOf('vpn') !== -1) {
      acc.push({
        id: app._name,
        name: `vpn-${app._name}`,
        _app: app
      });
    }
    return acc;
  }, [ { name: 'home' }]);
  networks.forEach((network) => {
    network.apps = apps.reduce((acc, app) => {
      let include = app._ip4.indexOf(network.name) !== -1;
      if (!include && network.name === 'home') {
        include = app._ip4.indexOf('bridge') !== -1;
      }
      if (include) {
        acc.push({
          id: app._name,
          online: app._online,
          name: `minke-${app._name}.local`,
          link: app._forward && app._forward.url
        });
      }
      return acc;
    }, []);
  });
  ctx.body = template({ networks: networks });
  ctx.type = 'text/html';
}

async function MainPageWS(ctx) {
  const apps = MinkeApp.getApps();

  function updateOnline(status) {
    ctx.websocket.send(JSON.stringify({
      type: 'update.html',
      selector: `.application-${status.app._name} .ready`,
      html: status.online ? '<span class="online">running</span>' : '<span class="offline">stopped</span>'
    }));
  }

  function updateStatus(status) {
    try {
      ctx.websocket.send(JSON.stringify({
        type: 'update.html',
        selector: `.application-${status.app._name} .status`,
        html: status.data
      }));
    }
    catch (_) {
    }
  }

  const oldStatus = {};

  function updateNetworkStatus(status) {
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
              name: service.target
            };
          }
        }
      });
    }
    const html = ghostsTemplate({ ghosts: Object.values(ghosts) });
    if (oldStatus[status.app._name] != html) {
      oldStatus[status.app._name] = html;
      try {
        ctx.websocket.send(JSON.stringify({
          type: 'update.html',
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
