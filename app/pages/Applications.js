const FS = require('fs');
const Handlebars = require('./HB');
const Pull = require('../Pull');
const MinkeApp = require('../MinkeApp');
const Images = require('../Images');
const Skeletons = require('../skeletons/Skeletons');

const NRTAGS = 20;

function _strhash(str) {
  let hash = 5381;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash << 5) - hash + bytes[i];
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
  ctx.body = template({ Advanced: MinkeApp.getAdvancedMode(), skeletons: catalog.map(skel => Object.assign({
    pre: skel.name.substr(0, 2),
    color: _strhash((skel.tags && skel.tags.length && skel.tags[0] || 'all').toLowerCase()) % NRTAGS
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
            const images = [ msg.value ];
            const skel = Skeletons.loadSkeleton(images[0], false);
            if (skel && skel.skeleton.secondary) {
              skel.skeleton.secondary.forEach(secondary => {
                images.push(secondary.image);
              });
            }
            const download = [];
            const extract = [];
            const success = await Promise.all(images.map((image, idx) => {
              return Pull.loadImage(Images.withTag(image), (progress) => {
                download[idx] = progress.download / images.length;
                extract[idx] = progress.extract / images.length;
                send({ type: 'html.update.attribute', selector: '.newapp .download', name: 'value', value: download.reduce((acc, val) => acc + (val || 0), 0) });
                send({ type: 'html.update.attribute', selector: '.newapp .extract', name: 'value', value: extract.reduce((acc, val) => acc + (val || 0), 0) });
              });
            }));
            if (success.reduce((acc, val) => acc & !!val, true)) {
              const app = await MinkeApp.create(images[0]);
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
        case 'skeleton.drop':
        {
          const skel = Skeletons.parse(msg.value);
          if (skel) {
            Skeletons.saveLocalSkeleton(skel);
            send({ type: 'skeleton.load', image: skel.image });
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
