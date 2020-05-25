const FS = require('fs');
const Config = require('../Config');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');

const consoleTemplate = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Console.html`, { encoding: 'utf8' }));

async function PageHTML(ctx) {
  const app = MinkeApp.getAppById(ctx.params.id);
  const tab = [
    { name: 'Main', cid: '', selected: (ctx.query.c || 'm') === 'm' },
    { name: 'Helper', cid: 'h', selected: (ctx.query.c === 'h' ) }
  ];
  app._secondary.forEach((_, idx) => tab.push({ name: `#${idx}`, cid: `${idx}`, selected: ctx.query.c == idx }));
  ctx.type = 'text/html';
  ctx.body = consoleTemplate({
    id: app._id,
    name: app._name,
    tab: tab
  });
}

async function PageWS(ctx) {
  const app = MinkeApp.getAppById(ctx.params.id);
  if (!app) {
    console.log(`Missing app ${ctx.params.id}`);
    return;
  }
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
  const exec = await container.exec({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Cmd: [ 'sh' ]
  });
  const stream = await exec.start({
    stdin: true
  });

  ctx.websocket.on('message', msg => {
    try {
      msg = JSON.parse(msg);
      switch (msg.type) {
        case 'console.from':
          stream.output.write(msg.value);
          break;
        default:
          break;
      }
    }
    catch (e) {
      console.log(e);
    }
  });
  ctx.websocket.on('error', () => {
    ctx.websocket.close();
    stream.output.destroy();
  });
  ctx.websocket.on('close', () => {
    stream.output.destroy();
  });

  function write(data) {
    try {
      ctx.websocket.send(JSON.stringify({ type: 'console.to', data: data.toString('utf8') }));
    }
    catch (_) {
    }
  }
  docker.modem.demuxStream(stream.output, { write: write }, { write: write });

  stream.output.on('close', () => {
    ctx.websocket.close();
  });
}

module.exports = {
  HTML: PageHTML,
  WS: PageWS
};
