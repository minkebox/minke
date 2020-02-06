const FS = require('fs');
const Path = require('path');
const UUID = require('uuid/v4');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');
const Images = require('../Images');
const Skeletons = require('../skeletons/Skeletons');
const Filesystem = require('../Filesystem');
const Network = require('../Network');
const Disks = require('../Disks');
const Backup = require('../Backup');
const UPNP = require('../UPNP');

let template;
let downloadTemplate;
function registerTemplates() {
  const partials = [
    'Table',
    'RTable',
    'Directory',
    'Shareables',
    'CustomShareables',
    'Websites',
    'Disks',
    'BackupAndRestore',
    'Download'
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, Handlebars.compile(
      FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }), { preventIndent: true }));
  });
  template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Configure.html`, { encoding: 'utf8' }), { preventIndent: true });
  downloadTemplate = Handlebars.compile('{{> Download}}', { preventIndent: true });
}
if (!DEBUG) {
  registerTemplates();
}

async function ConfigurePageHTML(ctx) {

  if (DEBUG) {
    registerTemplates();
  }

  const app = MinkeApp.getAppById(ctx.params.id);
  if (!app) {
    throw Error(`Missing app: ${ctx.params.id}`);
  }
  const skeleton = await Skeletons.loadSkeleton(app._image, true);
  if (!skeleton) {
    console.error(`Failed to load skeleton: ${app._image}`);
  }
  const minkeConfig = app._image == Images.MINKE;

  function expand(text) {
    return app.expand(text);
  }

  let nextid = 100;
  const visibles = {};
  const enabled = {};
  const properties = {
    Advanced: MinkeApp.getAdvancedMode(),
    FirstUse: app._bootcount == 0,
    WifiAvailable: minkeConfig ? (await Network.wifiAvailable()) : false
  };
  let help = false;
  const nskeleton = {
    name: skeleton.name,
    value: app._name,
    description: skeleton.description,
    actions: skeleton.actions.map((action) => {
      if ('visible' in action || 'enabled' in action) {
        const id = `x${++nextid}`;
        if ('visible' in action) {
          visibles[id] = action.visible;
          action = Object.assign({ id: id }, action);
        }
        if ('enabled' in action) {
          enabled[id] = action.enabled;
          action = Object.assign({ id: id }, action);
        }
      }
      switch (action.type) {
        case 'Header':
        {
          return action;
        }
        case 'Text':
        {
          return Object.assign({}, action, { text: expand(action.text) });
        }
        case 'Help':
        {
          help = true;
          return Object.assign({}, action, { text: expand(action.text) });
        }
        case 'Environment':
        {
          const property = skeleton.properties.find(property => property.type === action.type && property.name == action.name) || {};
          const env = app._env[action.name];
          properties[`${action.type}#${action.name}`] = env ? env.value : '';
          if (action.style === 'Table') {
            let value = [];
            if (env && env.altValue) {
              try {
                value = JSON.parse(env.altValue);
                const hlen = action.headers.length;
                value.forEach((v) => {
                  while (v.length < hlen) {
                    v.push('');
                  }
                });
              }
              catch (_) {
              }
            }
            return Object.assign({ action: `${action.type}#${action.name}`, value: value, controls: true }, action);
          }
          else if (action.style === 'Websites') {
            let currentSites = [];
            if (env && env.altValue) {
              try {
                currentSites = JSON.parse(env.altValue);
              }
              catch (_) {
              }
            }
            const websites = app.getAvailableWebsites().map((site) => {
              const match = currentSites.find(cs => cs[0] === site.app._id);
              return {
                appid: site.app._id,
                name: site.app._name,
                hostname: site.app._safeName(),
                port: site.port.port,
                dns: match ? match[3] : '',
                published: match ? !!match[4] : false
              };
            });
            return Object.assign({ action: `${action.type}#${action.name}`, websites: websites }, action);
          }
          else {
            let act;
            if (action.style === 'Checkbox') {
              act = `window.action('${action.type}#${action.name}',this.checked)`;
            }
            else {
              act = `window.action('${action.type}#${action.name}',this.value)`;
            }
            return Object.assign({ action: act, value: env ? env.value : '', options: property.options }, action);
          }
        }
        case 'NAT':
        {
          return Object.assign({ action: `window.action('${action.type}',this.checked)`, value: app._features.nat || false }, action, { description: expand(action.description) });
        }
        case 'Network':
        {
          const networks = [ { _id: 'none', name: 'none' } ].concat(app.getAvailableNetworks());
          const network = app._networks[action.name] || 'none';
          properties[`${action.type}#${action.name}`] = network;
          return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, networks: networks, value: network }, action);
        }
        case 'File':
        {
          const file = app._files.find(file => file.target === action.name);
          if (action.style === 'Table') {
            let value = [];
            if (file && file.altData) {
              try {
                value = JSON.parse(file.altData);
                const hlen = action.headers.length;
                value.forEach((v) => {
                  while (v.length < hlen) {
                    v.push('');
                  }
                });
              }
              catch (_) {
              }
            }
            return Object.assign({ action: `${action.type}#${action.name}`, value: value, controls: true }, action);
          }
          else if (action.style === 'RTable') {
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            let value = [];
            try {
              value = JSON.parse(file.data)
            }
            catch (_) {
            }
            return Object.assign({ value: value }, action);
          }
          else {
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            const value = file ? file.data : '';
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, value: value, filename: Path.basename(action.name) }, action);
          }
        }
        case 'Directory':
        {
          const allShares = app.getAvailableShareables();
          allShares.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);
          const shareables = allShares.map((shareable) => {
            return { app: shareable.app, shares: shareable.shares.reduce((shares, bind) => {
              bind.shares.forEach((share) => {
                const target = Path.normalize(`${shareable.app._name}/${bind.target}/${share.name}/`).slice(0, -1).replace(/\//g, '.');
                const src = Path.normalize(`${bind.src}/${share.sname || share.name}/`).slice(0, -1);
                shares.push({
                  name: target,
                  src: src,
                  description: share.description,
                  value: !!app._binds.find(abind => abind.src === src)
                });
              });
              return shares;
            }, [])};
          });
          return Object.assign({ action: `window.action('${action.type}#${action.name}',event.target.value)`, shareables: shareables }, action);
        }
        case 'Shareables':
        {
          const allShares = app.getAvailableShareables();
          allShares.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);
          const shareables = allShares.map((shareable) => {
            return { app: shareable.app, shares: shareable.shares.reduce((shares, bind) => {
              bind.shares.forEach((share) => {
                const target = Path.normalize(`${shareable.app._name}/${bind.target}/${share.name}/`).slice(0, -1).replace(/\//g, '.');
                const src = Path.normalize(`${bind.src}/${share.sname || share.name}/`).slice(0, -1);
                const ashare = app._shares.find(ashare => ashare.src === src);
                const alttarget = ashare ? ashare.target.substr(action.name.length + 1) : '';
                shares.push({
                  name: target,
                  altname: alttarget != target ? alttarget : null,
                  description: share.description,
                  action: `window.share('${action.type}#${shareable.app._id}#${src}#${action.name}#${target}',this)`,
                  value: !!ashare
                });
              });
              return shares;
            }, [])};
          });
          return Object.assign({ shareables: shareables }, action);
        }
        case 'CustomShareables':
        {
          const root = app._customshares.find(share => share.target == action.name) || { shares: [] };
          return Object.assign({ action: `${action.type}#${action.name}`, shareables: root.shares.map(share => {
            return {
              name: share.name,
              sname: share.sname,
              empty: FS.readdirSync(`${root.src}/${share.sname}`).length === 0
            };
          }) }, action);
        }
        case '__Disks':
        {
          if (!minkeConfig) {
            return {};
          }
          const diskinfo = Object.values(Disks.getAllDisks().diskinfo);
          const havestore = diskinfo.find(info => info.root === '/mnt/store');
          return {
            type: '__Disks',
            disks: diskinfo.map(disk => {
              return {
                name: disk.root === '/minke' ? 'boot' : disk.root === '/mnt/store' ? 'store' : disk.name,
                size: (disk.size / (1000 * 1000 * 1000)).toFixed(2) + 'GB',
                percentage: disk.size === 0 ? 0 : (disk.used / disk.size * 100).toFixed(1),
                tenth: parseInt(disk.size === 0 ? 0 : (disk.used / disk.size * 10)),
                status: disk.status,
                format: !havestore && disk.root !== '/minke'
              }
            })
          };
        }
        case 'UPnP':
        {
          const ip6 = app._homeIP && app.getNATIP6() ? app.getSLAACAddress() : null;
          const upnp = UPNP.available();
          if (upnp) {
            return {
              type: 'Empty'
            };
          }
          else {
            return {
              type: `Text`,
              text: `UPnP can be used to forward traffic from a router to this application. Unfortunately it does not appear to be available so you need to forward traffic manually${app._homeIP ? ' to IPv4 address <b>' + app._homeIP + '</b>' : ''}${ip6 ? ' and IPv6 address <b>' + ip6 + '</b>' : ''}`
            };
          }
        }
        case 'Argument':
        default:
          return action;
      }
    })
  }
  const advanced = MinkeApp.getAdvancedMode();
  const link = app.getWebLink();
  ctx.body = template({
    minkeConfig: minkeConfig,
    Advanced: advanced,
    skeleton: nskeleton,
    properties: JSON.stringify(properties),
    skeletonAsText: Skeletons.toString(skeleton),
    link: link.url,
    linktarget: link.target,
    firstUse: app._bootcount == 0,
    help: help,
    changes: '[' + Object.keys(visibles).map((key) => {
      return `function(){try{const c=document.getElementById("${key}").classList;if(${visibles[key]}){c.remove("invisible")}else{c.add("invisible")}}catch(_){}}`;
    }).concat(Object.keys(enabled).map((key) => {
      return `function(){try{const v=(${enabled[key]});document.querySelectorAll("#${key}.can-disable,#${key} .can-disable").forEach((e)=>{e.disabled=(v?'':'disabled');if(v){e.classList.remove("disabled")}else{e.classList.add("disabled")}})}catch(_){}}`
    })).join(',') + ']'
  });
  ctx.type = 'text/html'
}

async function ConfigurePageWS(ctx) {

  function send(msg) {
    try {
      ctx.websocket.send(JSON.stringify(msg));
    }
    catch (_) {
    }
  }

  let app = MinkeApp.getAppById(ctx.params.id);
  const skeleton = Skeletons.loadSkeleton(app._image, false);

  const NOCHANGE = 0;
  const APPCHANGE = 1;
  const SKELCHANGE = 2;
  const SHARECHANGE = 4;

  function getTableData(app, name, value) {
    const action = skeleton.actions.find(action => action.name === name);
    if (action && (action.style === 'Table' || action.style === 'Websites')) {
      const table = JSON.parse(value);
      const headers = action.headers || [];
      value = [];
      table.forEach((row) => {
        let line = action.pattern || '{{0}}';
        for (let i = 0; i < row.length; i++) {
          const header = headers[i] || {};
          let rowval = row[i];
          if (header.encoding === 'url') {
            rowval = encodeURIComponent(rowval);
          }
          line = line.replace(new RegExp('\\{\\{' + i + '\\}\\}', 'g'), rowval);
        }
        if (line.indexOf('{{') !== -1) {
          for (let key in app._env) {
            line = line.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), app._env[key].value);
          }
        }
        value.push(line);
      });
      return value.join('join' in action ? action.join : '\n');
    }
    return null;
  }

  const patterns = [
    { p: /^Name$/, f: (value, match) => {
      if (app._name != value) {
        app._name = value;
        return APPCHANGE;
      }
      return NOCHANGE;
    }},
    { p: /^Environment#(.+)$/, f: (value, match) => {
      const key = match[1];
      const tableValue = getTableData(app, key, value);
      const nvalue = tableValue !== null ? tableValue : value;
      let change = NOCHANGE;

      function update(r) {
        if (r) {
          if (tableValue !== null) {
            r.altValue = value;
          }
          else {
            delete r.altValue;
          }
          if (r.value !== nvalue) {
            r.value = nvalue;
            change = APPCHANGE;
          }
        }
      }

      update(app._env[key]);
      app._secondary.forEach(secondary => update(secondary._env[key]));

      return change;
    }},
    { p: /^NAT$/, f: (value, match) => {
      let change = NOCHANGE;
      if (app._features.nat !== value) {
        app._features.nat = value;
        change = APPCHANGE;
      }
      return change;
    }},
    { p: /^Network#(.+)$/, f: (value, match) => {
      const network = match[1];
      const ovalue = app._networks[network];
      if ((network in app._networks) && ovalue !== value) {
        app._networks[network] = value;
        const napp = MinkeApp.getAppById(ovalue);
        if (napp) {
          napp._needRestart = true;
        }
        return APPCHANGE;
      }
      return NOCHANGE;
    }},
    {
      p: /^Directory#(.+)$/, f: (value, match) => {
        const target = match[1];
        let change = NOCHANGE;

        function update(binds) {
          const bind = binds.find(bind => bind.target == target);
          if (bind && bind.src !== value) {
            bind.src = value;
            change = APPCHANGE;
          }
        }

        update(app._binds);
        app._secondary.forEach(secondary => update(secondary._binds));

        return change;
      }
    },
    { p: /^File#(.+)$/, f: (value, match) => {
      const filename = match[1];
      const tableValue = getTableData(app, filename, value);
      const nvalue = tableValue !== null ? tableValue : value;
      let change = NOCHANGE;

      function update(files) {
        const file = files.find(file => file.target == filename)
        if (file && file.data !== nvalue) {
          if (tableValue !== null) {
            file.altData = value;
          }
          else {
            delete file.altData;
          }
          file.data = nvalue;
          if (app._fs) {
            app._fs.makeFile(file);
          }
          change = APPCHANGE;
        }
      }

      update(app._files);
      app._secondary.forEach(secondary => update(secondary._files));

      return change;
    }},
    { p: /^Shareables#(.*)#(.*)#(.*)#(.*)$/, f: (value, match) => {
      const share = {
        src: match[2],
        target: `${match[3]}/${value.target.replace(/\//, '.') || match[4]}`,
        shared: value.shared
      };
      let changed = NOCHANGE;

      function update(shares) {
        const idx = shares.findIndex(oshare => oshare.src === share.src);
        if (share.shared) {
          if (idx !== -1) {
            if (shares[idx].target !== share.target) {
              shares[idx].target = share.target;
              changed = SHARECHANGE;
            }
          }
          else {
            shares.push({
              src: share.src,
              target: share.target
            });
            changed = SHARECHANGE;
          }
        }
        else {
          if (idx !== -1) {
            shares.splice(idx, 1);
            changed = SHARECHANGE;
          }
        }
      }

      update(app._shares);
      app._secondary.forEach(secondary => {
        update(secondary._shares);
      });

      return changed;
    }},
    { p: /^CustomShareables#(.+)$/, f: (value, match) => {
      const shareroot = match[1];
      const action = skeleton.actions.find(action => action.name === shareroot);

      const bind = {
        src: Filesystem.getNativePath(app._id, action.style, `/dir/${shareroot}`),
        target: Path.normalize(shareroot),
        shares: JSON.parse(value).map((row) => {
          return { name: Path.normalize(row[0]), sname: row[1] || UUID() };
        })
      };
      const idx = app._customshares.findIndex(oshare => oshare.target === bind.target);
      if (idx !== -1) {
        const obind = app._customshares[idx];
        obind.shares.forEach(share => {
          if (FS.readdirSync(`${obind.src}/${name}`).length !== 0 && !bind.shares.find(ns => ns.sname === share.sname)) {
            // Directory not empty, so make sure we keep it
            bind.shares.push(share);
          }
        });
      }
      if (bind.shares.length === 0) {
        if (idx !== -1) {
          app._customshares.splice(idx, 1);
        }
      }
      else if (idx !== -1) {
        app._customshares[idx] = bind;
      }
      else {
        app._customshares.push(bind);
      }
      return SHARECHANGE;
    }},
    { p: /^Skeleton$/, f: (value, match) => {
      const skel = Skeletons.parse(value);
      if (skel) {
        Skeletons.saveLocalSkeleton(skel);
        return SKELCHANGE;
      }
      return NOCHANGE;
    }}
  ];

  let changes = {};
  async function save(forceRestart) {
    try {
      let changed = 0;
      for (let property in changes) {
        patterns.find(pattern => {
          const match = property.match(pattern.p);
          if (match) {
            changed |= pattern.f(changes[property], match);
            return true;
          }
          return false;
        });
      }
      changes = {};

      if (changed || app._status === 'stopped' || forceRestart) {
        const uapp = app;
        if ((changed & SKELCHANGE) !== 0) {
          uapp.updateFromSkeleton(Skeletons.loadSkeleton(uapp._image, false), uapp.toJSON());
          app = null;
          send({
            type: 'page.reload'
          });
        }
        await uapp.restart(forceRestart ? 'restart' : null);
        await Promise.all(MinkeApp.needRestart().map(a => a.restart()));
      }
    }
    catch (e) {
      console.log(e);
    }
  }

  ctx.websocket.on('message', (msg) => {
    try {
      msg = JSON.parse(msg);
      switch (msg.type) {
        case 'action.change':
          changes[msg.property] = msg.value;
          break;
        case 'app.restart':
          if (app) {
            save(true);
          }
          break;
        case 'app.save':
          if (app) {
            save();
          }
          break;
        case 'app.reboot':
          if (app) {
            app.restart('reboot');
          }
          break;
        case 'app.halt':
          if (app) {
            app.restart('halt');
          }
          break;
        case 'app.delete':
          changes = {};
          app.uninstall();
          break;
        case 'app.format-disk':
          if (app._image === Images.MINKE) {
            Disks.format(msg.value, () => {
              send({
                type: 'page.reload'
              });
            });
          }
          break;
        case 'app.restore-all':
          if (app._image === Images.MINKE) {
            Backup.restore(msg.value);
          }
          break;
        case 'app.update-download':
        {
          const path = msg.value;
          const file = app._files.find(file => file.target === path);
          if (file && app._fs) {
            app._fs.readFile(file);
          }
          const value = file ? file.data : '';
          send({
            type: 'html.replace',
            selector: `#${path.replace(/[./]/g, '\\$&')}`,
            html: downloadTemplate({
              name: path,
              value: value,
              filename: Path.basename(path)
            })
          });
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
    if (app) {
      save();
    }
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

}

function tab(t) {
  let s = '';
  for (; t > 0; t--) {
    s += '  ';
  }
  return s;
}
function toText(o, t) {
  if (Array.isArray(o)) {
    let r = "[";
    for (let i = 0; i < o.length; i++) {
      r += `${i === 0 ? '' : ','}\n${tab(t+1)}${toText(o[i],t+1)}`;
    }
    r += `\n${tab(t)}]`;
    return r;
  }
  else switch (typeof o) {
    case 'string':
      return "`" + o + "`";
      break;
    case 'number':
    case 'boolean':
    case 'undefined':
      return o;
    case 'object':
      if (o === null) {
        return o;
      }
      let r = '{';
      const k = Object.keys(o);
      for (let i = 0; i < k.length; i++) {
        r += `${i === 0 ? '' : ','}\n${tab(t+1)}${k[i]}: ${toText(o[k[i]],t+1)}`;
      }
      r += `\n${tab(t)}}`;
      return r;
      break;
    default:
      break;
  }
  return '';
}

module.exports = {
  HTML: ConfigurePageHTML,
  WS: ConfigurePageWS
};
