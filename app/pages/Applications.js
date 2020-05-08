const FS = require('fs');
const Handlebars = require('./HB');
const Pull = require('../Pull');
const MinkeApp = require('../MinkeApp');
const Images = require('../Images');
const Skeletons = require('../Skeletons');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

  const running = {};
  MinkeApp.getApps().forEach(app => {
    running[app.skeletonId()] = true;
  });
  function canDelete(skel) {
    if (skel.source === 'builtin' || skel.source === 'internal-builtin') {
      return false;
    }
    return running[skel.image] ? false : true;
  }

  const catalog = Skeletons.catalog();
  ctx.body = template({ Advanced: MinkeApp.getAdvancedMode(), skeletons: catalog.map(skel => Object.assign({
    pre: skel.name.substr(0, 2),
    color: _strhash((skel.tags && skel.tags.length && skel.tags[0] || 'all').toLowerCase()) % NRTAGS,
    canDelete: canDelete(skel),
    personal: skel.source === 'local'
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
            let created = false;
            const images = [];
            const skel = Skeletons.loadSkeleton(msg.value, false);
            if (skel) {
              images.push(skel.skeleton.image);
              (skel.skeleton.secondary ||[]).forEach(secondary => {
                images.push(secondary.image);
              });
            }
            else if (!GUID.test(msg.value)) {
              images.push(msg.value);
              created = true;
            }
            const download = [];
            const extract = [];
            const success = await Promise.all(images.map((image, idx) => {
              return Pull.loadImage(Images.withTag(image), progress => {
                download[idx] = progress.download / images.length;
                extract[idx] = progress.extract / images.length;
                send({ type: 'html.update.attribute', selector: '.newapp .download', name: 'value', value: download.reduce((acc, val) => acc + (val || 0), 0) });
                send({ type: 'html.update.attribute', selector: '.newapp .extract', name: 'value', value: extract.reduce((acc, val) => acc + (val || 0), 0) });
              });
            }));
            if (images.length && success.reduce((acc, val) => acc & !!val, true)) {
              const app = await MinkeApp.create(msg.value);
              send({ type: 'page.redirect', url: `/configure/${app._id}/`, src: created ? 'open-editor' : '' });
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
            send({ type: 'skeleton.load', image: skel.uuid });
          }
          break;
        }
        case 'docker-compose.drop':
        {
          (async function() {
            const skel = Skeletons.parseDockerCompose(msg.value);
            if (skel) {
              Skeletons.saveLocalSkeleton(skel);
              const app = await MinkeApp.create(skel.uuid);
              send({ type: 'page.redirect', url: `/configure/${app._id}/`, src: 'open-editor' });
            }
          })();
          break;
        }
        case 'appimage.delete':
        {
          const apps = MinkeApp.getApps();
          let i;
          for (i = 0; i < apps.length; i++) {
            // Dont remove anything which is running
            if (apps[i].skeletonId() === msg.value) {
              break;
            }
          }
          if (i === apps.length) {
            Skeletons.removeImage(msg.value);
            send({ type: 'html.remove', selector: `.application-image[data-name="${msg.value}"]` });
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
