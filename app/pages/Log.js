const FS = require('fs');
const Config = require('../Config');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');
const Filesystem = require('../Filesystem');

const logTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Log.html`, { encoding: 'utf8' }));

async function PageHTML(ctx) {
  const app = MinkeApp.getAppById(ctx.params.id);
  let name = `Logs for ${app._name}`;
  switch (ctx.query.c || 'm') {
    case 'm':
      break;
    case 'h':
      name += ' (helper)';
      break;
    default:
      name += ` (secondary ${ctx.query.c})`;
      break;
  }
  ctx.type = 'text/html';
  ctx.body = logTemplate({
    name: name
  });
}

async function PageWS(ctx) {
try{
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

  function write(data) {
    try {
      ctx.websocket.send(JSON.stringify({ type: 'console.to', data: data.toString('utf8') }));
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
    docker.modem.demuxStream(logs, { write: write }, { write: write });
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
    write('[STDOUT]\n\n');
    write(logs.stdout);
    write('\n[STDERR]\n\n');
    write(logs.stderr);
    write('\n[TERMINATED]\n');
  }
} catch(e) { console.log(e); }
}

module.exports = {
  HTML: PageHTML,
  WS: PageWS
};
