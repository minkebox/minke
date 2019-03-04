const FS = require('fs');
const Path = require('path');

const CACHE_MAXAGE = 24 * 60 * 60; // 24 hours

const Pages = {
  '/':                require('./Main'),
  '/new/application': require('./Applications'),
  '/configure/:id':   require('./Configure')
};

function pages(root, wsroot) {

  root.get('/js/ace.js', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/../node_modules/ace-builds/${DEBUG ? 'src' : 'src-min'}/ace.js`, { encoding: 'utf8' });
    ctx.type = 'text/javascript';
    ctx.cacheControl = { maxAge: CACHE_MAXAGE };
  });
  root.get('/js/:script', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/script/${ctx.params.script}`, { encoding: 'utf8' });
    ctx.type = 'text/javascript';
  });
  root.get('/css/pure.css', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/../node_modules/purecss/build/pure-min.css`, { encoding: 'utf8' });
    ctx.type = 'text/css';
    ctx.cacheControl = { maxAge: CACHE_MAXAGE };
  });
  root.get('/css/chartist.css', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/../node_modules/chartist/dist/chartist.min.css`, { encoding: 'utf8' });
    ctx.type = 'text/css';
    ctx.cacheControl = { maxAge: CACHE_MAXAGE };
  });
  root.get('/css/:style', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/css/${ctx.params.style}`, { encoding: 'utf8' });
    ctx.type = 'text/css';
  });
  root.get('/img/:img', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/img/${ctx.params.img}`);
    ctx.type = 'image/png';
  });

  for (let key in Pages) {
    if (Pages[key].HTML) {
      root.get(key, Pages[key].HTML);
    }
    if (Pages[key].WS) {
      wsroot.get(Path.normalize(`${key}/ws`), Pages[key].WS);
    }
  }
}

module.exports = {
  register: pages
};
