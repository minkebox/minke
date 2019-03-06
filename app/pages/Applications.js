const FS = require('fs');
const Handlebars = require('./HB');
const Pull = require('../Pull');
const MinkeApp = require('../MinkeApp');
const Skeletons = require('../skeletons/Skeletons');

function _strhash(str) {
  let hash = 5381;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash << 5) + hash + bytes[i];
  }
  return hash & 0x7fffffff;
}

async function PageHTML(ctx) {

  const partials = [
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
  const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Applications.html`, { encoding: 'utf8' }));

  const catalog = Skeletons.catalog();
  ctx.body = template({ adminMode: MinkeApp.getAdminMode(), skeletons: catalog.map(skel => Object.assign({ 
    pre: skel.name.substr(0, 2),
    color: _strhash(skel.name.substr(0, 2)) % 10
  }, skel)) });
  ctx.type = 'text/html';
}

async function PageWS(ctx) {

  function send(msg) {
    try {
      ctx.websocket.send(JSON.stringify(msg));
    }
    catch (_) {
    }
  }

  ctx.websocket.on('message', (msg) => {
    //console.log(msg);
    try {
      msg = JSON.parse(msg);
      switch (msg.type) {
        case 'newapp.image':
        {
          (async function() {
            const info = await Pull.loadImage(msg.value, (progress) => {
              send({ type: 'html.update.attribute', selector: '.newapp .download', name: 'value', value: progress.download });
              send({ type: 'html.update.attribute', selector: '.newapp .extract', name: 'value', value: progress.extract });
            });
            if (info) {
              const app = await MinkeApp.create(info);
              send({ type: 'page.redirect', url: `/configure/${app._id}/`});
            }
            else {
              send({ type: 'css.class.add', selector: '.download-spinner', className: 'error' });
              send({ type: 'html.update', selector: '.download-message', html: 'Download failed' });
            }
          })();
          break;
        }
        case 'newapp.cancel':
          Pull.cancel();
          break;
        default:
          break;
      }
    }
    catch (_) {
    }
  });

  ctx.websocket.on('close', () => {
    // ...
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });
}

module.exports = {
  HTML: PageHTML,
  WS: PageWS
};
