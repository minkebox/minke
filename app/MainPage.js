const FS = require('fs');
const Handlebars = require('handlebars');
const MinkeApp = require('./MinkeApp');

async function MainPageHTML(ctx) {
  const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/MainPage.html`, { encoding: 'utf8' }));
  const apps = Object.values(MinkeApp.getRunningApps()).map((app) => {
    return {
      name: app._name,
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
      apps[name].off('status.update', update);
    }
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

  for (let name in apps) {
    apps[name].on('status.update', update);
  }

  let count = 1;
  let clock = setInterval(() => {
    try {
      update({
        app: { _name: 'wsdemo' },
        html: `<div>${count++}</div>`
      });
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
