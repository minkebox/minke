const FS = require('fs');
const Handlebars = require('handlebars');
const MinkeApp = require('../MinkeApp');


async function SettingsPageHTML(ctx) {

  const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Settings.html`, { encoding: 'utf8' }));

  const app = MinkeApp.getApps().find((item) => {
    return item._name === ctx.params.id;
  })
  ctx.body = template({ app: app });
  ctx.type = 'text/html';
}

async function SettingsPageWS(ctx) {

  const app = MinkeApp.getApps().find((item) => {
    return item._name === ctx.params.id;
  })

  ctx.websocket.on('message', (msg) => {
    // ...
  });

  ctx.websocket.on('close', () => {
    // ...
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });
}

module.exports = {
  HTML: SettingsPageHTML,
  WS: SettingsPageWS
};
