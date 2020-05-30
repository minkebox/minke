const FS = require('fs');
const Config = require('../Config');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');
const Filesystem = require('../Filesystem');

const logTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Log.html`, { encoding: 'utf8' }));

async function PageHTML(ctx) {
  const app = MinkeApp.getAppById(ctx.params.id);
  const tab = [{ name: 'Main', cid: '', selected: (ctx.query.c || 'm') === 'm' }];
  if (app._networks.primary.name !== 'host') {
    tab.push({ name: 'Helper', cid: 'h', selected: (ctx.query.c === 'h' ) });
  }
  app._secondary.forEach((_, idx) => tab.push({ name: `#${idx}`, cid: `${idx}`, selected: ctx.query.c == idx }));
  ctx.type = 'text/html';
  ctx.body = logTemplate({
    id: app._id,
    name: `Logs for ${app._name}`,
    tab: tab
  });
}

async function PageWS(ctx) {
  const app = MinkeApp.getAppById(ctx.params.id);
  if (!app) {
    console.log(`Missing app ${ctx.params.id}`);
    return;
  }

  let logs = { destroy: function() {} };

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
    logs.destroy();
  });
  ctx.websocket.on('close', () => {
    logs.destroy();
  });

  function write(prefix, data) {
    try {
      ctx.websocket.send(JSON.stringify({ type: 'console.to', data: `${prefix}${data.toString('utf8')}` }));
    }
    catch (_) {
    }
  }

  if (app.isRunning()) {
    let container = null;
    switch (ctx.query.c || 'm') {
      case 'm':
        container = app._container;
        break;
      case 'h':
        container = app._helperContainer;
        break;
      default:
        if (app._secondaryContainers) {
          container = app._secondaryContainers[ctx.query.c];
        }
        break;
    }
    if (!container) {
      console.log(`Missing container ${ctx.query.c || 'm'} for ${app._name}`);
      return;
    }

    logs = await container.logs({
      follow: true,
      stdout: true,
      stderr: true
    });
    logs.on('close', () => {
      ctx.websocket.close();
    });
    docker.modem.demuxStream(logs, { write: data => write('\033[37m', data) }, { write: data => write('\033[33m', data) });
  }
  else {
    const fs = Filesystem.create(app);
    let ext = '';
    switch (ctx.query.c || 'm') {
      case 'm':
        break;
      case 'h':
        ext = '_helper';
        break;
      default:
        ext = `_${ctx.query.c}`;
        break;
    }
    const logs = fs.getLogs(ext);
    write('\033[37m', '[STDOUT]\n');
    write('\033[37m', logs.stdout);
    write('\033[33m', '\n[STDERR]\n');
    write('\033[33m', logs.stderr);
    write('\033[31m', '\n[TERMINATED]\n');
  }
}

module.exports = {
  HTML: PageHTML,
  WS: PageWS
};
