const FS = require('fs');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');

const NRTAGS = 20;

function genApp(app, tags) {
  return {
    _id: app._id,
    name: app._name,
    status: app._status,
    ip: app._status !== 'running' ? null : app._homeIP,
    link: app._forward && app._forward.url,
    linktarget: app._forward && app._forward.target,
    tags: app._tags,
    tagcolor: tags.indexOf(app._tags[0]) % NRTAGS,
    networks: [
      app._networks.primary === 'host' ? 'home' : app._networks.primary,
      app._networks.secondary === 'host' ? 'home' : app._networks.secondary
    ]
  }
}

function genAppStatus(acc, app, tags) {
  if (app._monitor.cmd) {
    acc.push({
      _id: app._id,
      name: app._name,
      header: app._monitor.header,
      minwidth: app._monitor.minwidth,
      link: app._forward && app._forward.url,
      linktarget: app._forward && app._forward.target,
      running: app._status === 'running',
      tags: app._tags,
      tagcolor: tags.indexOf(app._tags[0]) % NRTAGS,
    });
  }
  return acc;
}

let mainTemplate;
let appTemplate;
let appStatusTemplate;
let tagsTemplate;
function registerTemplates() {
  const partials = [
    'App',
    'AppStatus',
    'Tags',
    'Networks'
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
  mainTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Main.html`, { encoding: 'utf8' }));
  appTemplate = Handlebars.compile('{{> App}}');
  appStatusTemplate = Handlebars.compile('{{> AppStatus}}');
  tagsTemplate = Handlebars.compile('{{> Tags}}');
  networksTemplate = Handlebars.compile('{{> Networks}}');
}
if (!DEBUG) {
  registerTemplates();
}


async function MainPageHTML(ctx) {

  if (DEBUG) {
    registerTemplates();
  }

  const tags = MinkeApp.getTags();
  const networks = MinkeApp.getNetworks();
  const apps = MinkeApp.getApps().map(app => genApp(app, tags));
  const statuses = MinkeApp.getApps().reduce((acc, app) => genAppStatus(acc, app, tags), []);
  ctx.body = mainTemplate({ adminMode: MinkeApp.getAdminMode(), tags: tags, networks: networks, apps: apps, statuses: statuses });
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

  function updateStatus(event) {
    if (event.status !== onlines[event.app._id]) {
      const tags = MinkeApp.getTags();
      const html = appTemplate(genApp(event.app, tags));
      send({
        type: 'html.replace',
        selector: `.application-${event.app._id}`,
        html: html
      });
      const appstatus = genAppStatus([], event.app, tags);
      if (appstatus.length) {
        send({
          type: 'html.replace',
          selector: `.application-status-${event.app._id}`,
          html: appStatusTemplate(appstatus[0])
        });
      }
      delete oldStatus[event.app._id];
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

  function online(app) {
    app.on('update.status', updateStatus);
    app.on('update.monitor', updateMonitor);
  }

  function offline(app) {
    app.off('update.status', updateStatus);
    app.off('update.monitor', updateMonitor);
  }

  function createApp(status) {
    const tags = MinkeApp.getTags();
    const html = appTemplate(genApp(status.app, tags));
    send({
      type: 'html.append',
      selector: `#app-insertion-point`,
      html: html
    });
    online(status.app);
    const appstatus = genAppStatus([], status.app, tags);
    if (appstatus.length) {
      send({
        type: 'html.append',
        selector: `#appstatus-insertion-point`,
        html: appStatusTemplate(appstatus[0])
      });
    }
    send({
      type: 'html.update',
      selector: '#tag-insertion-point',
      html: tagsTemplate({ tags: tags })
    });
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
    send({
      type: 'html.update',
      selector: '#tag-insertion-point',
      html: tagsTemplate({ tags: MinkeApp.getTags() })
    });
    offline(status.app);
  }

  function updateNetworks() {
    const networks = MinkeApp.getNetworks();
    send({
      type: 'html.update',
      selector: '#network-insertion-point',
      html: networksTemplate({ networks: networks })
    });
  }

  ctx.websocket.on('close', () => {
    MinkeApp.getApps().forEach(app => offline(app));
    MinkeApp.off('app.create', createApp);
    MinkeApp.off('app.remove', removeApp);
    MinkeApp.off('net.create', updateNetworks);
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  MinkeApp.getApps().forEach(app => online(app));
  MinkeApp.on('app.create', createApp);
  MinkeApp.on('app.remove', removeApp);
  MinkeApp.on('net.create', updateNetworks);
}

module.exports = {
  HTML: MainPageHTML,
  WS: MainPageWS
};
