const FS = require('fs');
const Config = require('../Config');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');

const NRTAGS = 20;

function _strhash(str) {
  let hash = 5381;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash << 5) - hash + bytes[i];
  }
  return hash & 0x7fffffff;
}

function tagColor(tag) {
  return _strhash(tag.toLowerCase()) % NRTAGS
}

function tagsToMap(tags) {
  return tags.map(tag => { return { name: tag, color: tagColor(tag) } });
}

function genApp(app) {
  const link = app.getWebLink();
  return {
    _id: app._id,
    name: app._name,
    status: app._status,
    ip: app._status !== 'running' ? null : app._defaultIP,
    link: link.url,
    linktarget: link.target,
    tags: app._tags,
    tagcolor: tagColor(app._tags[0].toLowerCase()),
    networks: [
      app._networks.primary === 'host' ? 'home' : app._networks.primary,
      app._networks.secondary === 'host' ? 'home' : app._networks.secondary
    ]
  }
}

function genAppStatus(acc, app) {
  if (app._monitor.cmd) {
    acc.push({
      _id: app._id,
      name: app._name,
      init: app._statusMonitor && app._statusMonitor.init,
      minwidth: app._monitor.minwidth,
      link: app._forward && app._forward.url,
      linktarget: app._forward && app._forward.target,
      running: app._status === 'running',
      tags: app._tags,
      tagcolor: tagColor(app._tags[0]),
      networks: [
        app._networks.primary === 'host' ? 'home' : app._networks.primary,
        app._networks.secondary === 'host' ? 'home' : app._networks.secondary
      ]
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
  const apps = MinkeApp.getApps().map(app => genApp(app));
  const statuses = MinkeApp.getApps().reduce((acc, app) => genAppStatus(acc, app), []);
  ctx.body = mainTemplate({ configName: Config.CONFIG_NAME === 'Production' ? null : Config.CONFIG_NAME, Advanced: MinkeApp.getAdvancedMode(), tags: tagsToMap(tags), networks: networks, apps: apps, statuses: statuses });
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

  const onlines = {};

  function updateStatus(event) {
    if (event.status !== onlines[event.app._id]) {
      const html = appTemplate(genApp(event.app));
      send({
        type: 'html.replace',
        selector: `.application-${event.app._id}`,
        html: html
      });
      const appstatus = genAppStatus([], event.app);
      if (appstatus.length) {
        send({
          type: 'html.replace',
          selector: `.application-status-${event.app._id}`,
          html: appStatusTemplate(appstatus[0])
        });
      }
      onlines[event.app._id] = event.status;
    }
  }

  async function updateMonitor(app) {
    if (app._statusMonitor && app._statusMonitor.update) {
      const update = await app._statusMonitor.update();
      send({
        type: 'monitor2.reply',
        id: app._id,
        reply: update
      });
    }
  }

  function online(app) {
    app.on('update.status', updateStatus);
  }

  function offline(app) {
    app.off('update.status', updateStatus);
  }

  function createApp(status) {
    const tags = MinkeApp.getTags();
    const html = appTemplate(genApp(status.app));
    send({
      type: 'html.append',
      selector: `#app-insertion-point`,
      html: html
    });
    online(status.app);
    const appstatus = genAppStatus([], status.app);
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
      html: tagsTemplate({ tags: tagsToMap(tags) })
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
      html: tagsTemplate({ tags: tagsToMap(MinkeApp.getTags()) })
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

  ctx.websocket.on('message', (msg) => {
    try {
      msg = JSON.parse(msg);
      switch (msg.type) {
        case 'monitor2.request':
        {
          const app = MinkeApp.getAppById(msg.value);
          if (app) {
            updateMonitor(app);
          }
          break;
        }
        default:
          break;
      }
    }
    catch (_) {
    }
  });

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
