const FS = require('fs');
const Path = require('path');
const Config = require('../Config');

const CACHE_MAXAGE = 24 * 60 * 60; // 24 hours
const debug = (Config.CONFIG_NAME !== 'Production');

const Pages = {
  '/':                require('./Main'),
  '/new/application': require('./Applications'),
  '/configure/:id':   require('./Configure'),
  '/minkebox.config': require('../ConfigBackup'),
  '/console/:id':     require('./Console')
};

const JSPages = {
  '/js/ace.js':                 `${__dirname}/../node_modules/ace-builds/${debug ? 'src' : 'src-min'}/ace.js`,
  '/js/chart.js':               `${__dirname}/../node_modules/chart.js/dist/${debug ? 'Chart.js' : 'Chart.min.js'}`,
  '/js/sortable.js':            `${__dirname}/../node_modules/sortablejs/${debug ? 'Sortable.js' : 'Sortable.min.js'}`,
  '/js/xterm.js':               `${__dirname}/../node_modules/xterm/lib/xterm.js`,
  '/js/xterm.js.map':           `${__dirname}/../node_modules/xterm/lib/xterm.js.map`,
  '/js/xterm-addon-fit.js':     `${__dirname}/../node_modules/xterm-addon-fit/lib/xterm-addon-fit.js`,
  '/js/xterm-addon-fit.js.map': `${__dirname}/../node_modules/xterm-addon-fit/lib/xterm-addon-fit.js.map`
};

function pages(root, wsroot) {

  for (let key in JSPages) {
    const body = FS.readFileSync(JSPages[key], { encoding: 'utf8' });
    root.get(key, async (ctx) => {
      ctx.body = body;
      ctx.type = 'text/javascript';
      ctx.cacheControl = { maxAge: CACHE_MAXAGE };
    });
  }

  root.get('/js/:script', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/script/${ctx.params.script}`, { encoding: 'utf8' });
    ctx.type = 'text/javascript';
    if (!debug) {
      ctx.cacheControl = { maxAge: CACHE_MAXAGE };
    }
  });
  root.get('/css/pure.css', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/../node_modules/purecss/build/pure-min.css`, { encoding: 'utf8' });
    ctx.type = 'text/css';
    ctx.cacheControl = { maxAge: CACHE_MAXAGE };
  });
  root.get('/css/xterm.css', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/../node_modules/xterm/css/xterm.css`, { encoding: 'utf8' });
    ctx.type = 'text/css';
    ctx.cacheControl = { maxAge: CACHE_MAXAGE };
  });
  root.get('/css/:style', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/css/${ctx.params.style}`, { encoding: 'utf8' });
    ctx.type = 'text/css';
    if (!debug) {
      ctx.cacheControl = { maxAge: CACHE_MAXAGE };
    }
  });
  root.get('/img/:img', async (ctx) => {
    ctx.body = FS.readFileSync(`${__dirname}/img/${ctx.params.img}`);
    ctx.type = 'image/png';
    ctx.cacheControl = { maxAge: CACHE_MAXAGE };
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
