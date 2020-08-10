const FS = require('fs');
const Config = require('../Config');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');
const Images = require('../Images');

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
  const link = app.getWebLink('tab');
  return {
    _app: app,
    _id: app._id,
    name: app._name,
    status: app._status,
    ip: app._status !== 'running' ? null : app._defaultIP,
    link: link.url,
    linktarget: link.target,
    tags: app._tags,
    tagcolor: tagColor(app._tags[0].toLowerCase()),
    position: app._position.tab,
    networks: [
      app._networks.primary.name === 'host' ? 'home' : app._networks.primary.name,
      app._networks.secondary.name === 'host' ? 'home' : app._networks.secondary.name
    ]
  }
}

function genAppStatus(acc, app) {
  if (app._monitor.cmd) {
    const link = app.getWebLink('widget');
    acc.push({
      _app: app,
      _id: app._id,
      name: app._name,
      init: app._statusMonitor && app._statusMonitor.init,
      link: link.url,
      linktarget: link.target,
      running: app._status === 'running',
      tags: app._tags,
      tagcolor: tagColor(app._tags[0]),
      position: app._position.widget,
      networks: [
        app._networks.primary.name === 'host' ? 'home' : app._networks.primary.name,
        app._networks.secondary.name === 'host' ? 'home' : app._networks.secondary.name
      ]
    });
  }
  return acc;
}

function posSort(a, b) {
  return a.position - b.position;
}

function sortAndRenumber(list, tag) {
  list.sort(posSort);
  for (let i = 0; i < list.length; i++) {
    list[i]._position = i;
    list[i]._app._position[tag] = i;
  }
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
  sortAndRenumber(apps, 'tab');
  sortAndRenumber(statuses, 'widget');
  ctx.body = mainTemplate({
    configName: Config.CONFIG_NAME === 'Production' ? null : Config.CONFIG_NAME,
    Advanced: MinkeApp.getAdvancedMode(),
    DarkMode: MinkeApp.getDarkMode(),
    tags: tagsToMap(tags),
    networks: networks,
    apps: apps,
    statuses: statuses
  });
  ctx.type = 'text/html';
}

async function MainPageWS(ctx) {

  const onlines = {};
  MinkeApp.getApps().forEach(app => onlines[app._id] = app._status);

  function send(msg) {
    try {
      ctx.websocket.send(JSON.stringify(msg));
    }
    catch (_) {
    }
  }

  function updateStatus(event) {
    if (event.status !== onlines[event.app._id] || event.app._image === Images.MINKE) {
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

  function createApp(status) {
    const tags = MinkeApp.getTags();
    const html = appTemplate(genApp(status.app));
    send({
      type: 'html.append',
      selector: `#app-insertion-point`,
      html: html
    });
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

    // Appending app to tabs, so will get the last position.
    // App has already been added to the list.
    const tabs = MinkeApp.getApps();
    status.app._position.tab = tabs.length - 1;
    if (appstatus.length) {
      // Appending to the widgets, so we have to calculate that position as not all apps have widgets
      const count = tabs.reduce((acc, app) => acc += (app._monitor.cmd ? 1 : 0), 0);
      status.app._position.widget = count - 1;
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
    send({
      type: 'html.update',
      selector: '#tag-insertion-point',
      html: tagsTemplate({ tags: tagsToMap(MinkeApp.getTags()) })
    });

    // Remove app from tabs.
    // App has already been removed.
    const tabs = MinkeApp.getApps();
    tabs.forEach(app => {
      if (app._position.tab >= status.app._position.tab) {
        app._position.tab--;
      }
    });
    const widgets = MinkeApp.getApps().reduce((acc, app) => ((app._monitor.cmd ? acc.push(app) : false), acc), []);
    widgets.forEach(app => {
      if (app._position.tab >= status.app._position.widget) {
        app._position.widget--;
      }
    });
  }

  function updateNetworks() {
    const networks = MinkeApp.getNetworks();
    send({
      type: 'html.update',
      selector: '#network-insertion-point',
      html: networksTemplate({ networks: networks })
    });
  }

  function updateOperational(data) {
    send({
      type: 'html.update',
      selector: '.main .operational',
      html: `CPU: ${data.cpuLoad}%&nbsp;&nbsp;&nbsp;Memory: ${data.memoryUsed}%`
    });
  }

  function openCaptcha(data) {
    send({ type: 'system.captcha', url: `${Config.CAPTCH_QUESTION}${MinkeApp.getDarkMode() ? '?darkmode=true' : ''}` });
    Root.emit('system.captcha.token', { token: 'maybe' });
  }

  ctx.websocket.on('message', async (msg) => {
    try {
      msg = JSON.parse(msg);
      switch (msg.type) {
        case 'monitor2.request':
        {
          const app = MinkeApp.getAppById(msg.value);
          if (app && app._statusMonitor) {
            send({
              type: 'monitor2.reply',
              id: app._id,
              reply: await app._statusMonitor.update()
            });
          }
          break;
        }
        case 'app.move.tab':
        {
          const move = MinkeApp.getAppById(msg.value.id);
          const from = msg.value.from;
          const to = msg.value.to;
          if (move && from !== to) {
            const tabs = MinkeApp.getApps();
            if (from > to) {
              tabs.forEach(app => {
                if (app._position.tab >= to && app._position.tab <= from) {
                  app._position.tab++;
                }
              });
            }
            else {
              tabs.forEach(app => {
                if (app._position.tab >= from && app._position.tab <= to) {
                  app._position.tab--;
                }
              });
            }
            move._position.tab = to;
            Root.emit('apps.tabs.reorder');
          }
          break;
        }
        case 'app.move.widget':
        {
          const move = MinkeApp.getAppById(msg.value.id);
          const from = msg.value.from;
          const to = msg.value.to;
          if (move && move._monitor.cmd && from !== to) {
            const widgets = MinkeApp.getApps().reduce((acc, app) => ((app._monitor.cmd ? acc.push(app) : false), acc), []);
            if (from > to) {
              widgets.forEach(app => {
                if (app._position.widget >= to && app._position.widget <= from) {
                  app._position.widget++;
                }
              });
            }
            else {
              widgets.forEach(app => {
                if (app._position.widget >= from && app._position.widget <= to) {
                  app._position.widget--;
                }
              });
            }
            move._position.widget = to;
            Root.emit('apps.widgets.reorder');
          }
          break;
        }
        case 'system.captcha.token':
          Root.emit('system.captcha.token', { token: msg.value });
          break;
        default:
          break;
      }
    }
    catch (_) {
    }
  });

  ctx.websocket.on('close', () => {
    Root.off('app.status.update', updateStatus);
    Root.off('app.create', createApp);
    Root.off('app.remove', removeApp);
    Root.off('net.create', updateNetworks);
    Root.off('net.remove', updateNetworks);
    Root.off('system.stats', updateOperational);
    Root.off('system.captcha', openCaptcha);
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  Root.on('app.status.update', updateStatus);
  Root.on('app.create', createApp);
  Root.on('app.remove', removeApp);
  Root.on('net.create', updateNetworks);
  Root.on('net.remove', updateNetworks);
  Root.on('system.stats', updateOperational);
  Root.on('system.captcha', openCaptcha);
}

module.exports = {
  HTML: MainPageHTML,
  WS: MainPageWS
};
