const FS = require('fs');
const Handlebars = require('handlebars');
const MinkeApp = require('../MinkeApp');

Handlebars.registerHelper({
  eq: function (v1, v2) {
    return v1 === v2;
  },
  ne: function (v1, v2) {
    return v1 !== v2;
  },
  lt: function (v1, v2) {
    return v1 < v2;
  },
  gt: function (v1, v2) {
    return v1 > v2;
  },
  lte: function (v1, v2) {
    return v1 <= v2;
  },
  gte: function (v1, v2) {
    return v1 >= v2;
  },
  and: function () {
    return Array.prototype.slice.call(arguments).every(Boolean);
  },
  or: function () {
    return Array.prototype.slice.call(arguments, 0, -1).some(Boolean);
  }
});

function genApp(app) {
  return {
    id: app._name,
    online: app._online,
    features: app._features,
    link: app._forward && app._forward.url,
    networks: {
      primary: app._networks.primary,
      secondary: app._networks.secondary === 'vpn' ? `vpn-${app._name}` : app._networks.secondary
    }
  }
}


async function MainPageHTML(ctx) {

  const partials = [
    'App',
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
  const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Main.html`, { encoding: 'utf8' }));

  const networks = MinkeApp.getNetworks();
  const apps = MinkeApp.getApps().map(app => genApp(app));
  ctx.body = template({ networks: networks, apps: apps });
  ctx.type = 'text/html';
}

async function MainPageWS(ctx) {

  const ghostsTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Ghosts.html`, { encoding: 'utf8' }));

  const apps = MinkeApp.getApps();

  function updateNetworkConfig(status) {
    const html = Handlebars.compile('{{> App}}')(Object.assign(genApp(status.app), { allnetworks: MinkeApp.getNetworks() }));
    try {
      ctx.websocket.send(JSON.stringify({
        type: 'html.update',
        selector: `.application-${status.app._name}`,
        html: html
      }));
    }
    catch (_) {
    }
  }

  const onlines = apps.reduce((acc, app) => {
    acc[app._name] = app._online;
    return acc;
  }, {});
  function updateOnline(status) {
    if (status.online != onlines[status.app._name]) {
      onlines[status.app._name] = status.online;
      updateNetworkConfig(status);
    }
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
    const networks = MinkeApp.getNetworks();
    const apps = MinkeApp.getApps();
    const services = status.data;
    const ghosts = {};
    for (let name in services) {
      services[name].forEach((service) => {
        if (!ghosts[service.target]) {
          const id = service.target.replace(/minke-(.*).local/, "$1");
          if (apps.find(app => app._name == id && app._networks.primary !== `vpn-${status.app._name}` && app._networks.secondary !== `vpn-${status.app._name}`)) {
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
          selector: `.network-${status.app._name}`,
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
      app.off('update.network.config', updateNetworkConfig);
    });
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  apps.forEach((app) => {
    app.on('update.online', updateOnline);
    app.on('update.status', updateStatus);
    app.on('update.network.status', updateNetworkStatus);
    app.on('update.network.config', updateNetworkConfig);
  });
}

module.exports = {
  HTML: MainPageHTML,
  WS: MainPageWS
};
