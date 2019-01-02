const FS = require('fs');
const Handlebars = require('handlebars');
const MinkeApp = require('./MinkeApp');

async function MainPageHTML(ctx) {
  const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/MainPage.html`, { encoding: 'utf8' }));
  const apps = Object.values(MinkeApp.getRunningApps()).map((app) => {
    return {
      online: true,
      name: app._name,
      status: app._statusHTML,
      link: !!app._forward
    }
  })
  ctx.body = template({ apps: apps });
  ctx.type = 'text/html';
}

async function MainPageWS(ctx) {
  const apps = MinkeApp.getRunningApps();

  function update(status) {
    ctx.websocket.send(JSON.stringify({
      type: 'html.update',
      id: status.app._name,
      html: status.html
    }));
  }

  ctx.websocket.on('message', (msg) => {
  });

  ctx.websocket.on('close', () => {
    for (let name in apps) {
      const app = apps[name];
      app.removeListener('status.update', update);
    }
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  for (let name in apps) {
    const app = apps[name];
    app.on('status.update', update);
  }

  let count = 1;
  let clock = setInterval(() => {
    try {
      ctx.websocket.send(JSON.stringify({
        type: 'html.update',
        id: 'wsdemo',
        html: `<div>${count}</div>`
      }));
      count++;
    }
    catch (_) {
      clearInterval(clock);
    }
  }, 1000);
}

module.exports = {
  HTML: MainPageHTML,
  WS: MainPageWS
};
