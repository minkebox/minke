const FS = require('fs');
const Path = require('path');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');
const Images = require('../Images');
const Skeletons = require('../skeletons/Skeletons');

let template;
function registerTemplates() {
  const partials = [
    'Table',
    'Shareables',
    'CustomShareables',
    'Websites'
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
  template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Configure.html`, { encoding: 'utf8' }));
}
if (!DEBUG) {
  registerTemplates();
}

async function ConfigurePageHTML(ctx) {

  if (DEBUG) {
    registerTemplates();
  }

  const app = MinkeApp.getApps().find(item => item._id === ctx.params.id);
  if (!app) {
    throw Error(`Missing app: ${ctx.params.id}`);
  }
  const skeleton = await Skeletons.loadSkeleton(app._image, true);
  if (!skeleton) {
    console.error(`Failed to load skeleton: ${app._image}`);
  }

  function expand(text) {
    return (text || '').replace(/\{\{GLOBALNAME\}\}/g, `${MinkeApp.getGlobalID()}.minkebox.net`);
  }

  let nextid = 100;
  const visibles = {};
  const enabled = {};
  const properties = {
    AdminMode: MinkeApp.getAdminMode(),
    FirstUse: app._bootcount == 0
  };
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
                port: site.port.host,
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
          const natport = app._ports.find(port => action.ports.indexOf(port.target) !== -1) || { nat: false };
          return Object.assign({ action: `window.action('${action.type}#${action.ports.join('#')}',this.checked)`, value: natport.nat }, action, { description: expand(action.description) });
        }
        case 'Network':
        {
          const networks = [ { _id: 'none', name: 'none' } ].concat(app.getAvailableNetworks());
          const network = app._networks[action.name] || 'none'
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
          else {
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            const value = file ? file.data : '';
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, value: value, filename: Path.basename(action.name) }, action);
          }
        }
        case 'Shareables':
        {
          const allShares = app.getAvailableShareables();
          allShares.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);
          const shareables = allShares.map((shareable) => {
            return { app: shareable.app, shares: shareable.shares.reduce((shares, bind) => {
              bind.shares.forEach((share) => {
                const target = Path.normalize(`${shareable.app._name}/${bind.target}/${share.name}/`).slice(0, -1).replace(/\//g, '.');
                const host = Path.normalize(`${bind.host}/${share.name}/`).slice(0, -1);
                const ashare = app._shares.find(ashare => ashare.appid === shareable.app._id && ashare.host == host);
                shares.push({
                  name: target,
                  altname: ashare && ashare.target != target ? ashare.target : null,
                  description: share.description,
                  host: host,
                  action: `window.share('${action.type}#${shareable.app._id}#${host}#${action.name}#${target}',this)`,
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
          return Object.assign({ action: `${action.type}#${action.name}`, shareables: root.shares }, action);
        }
        case 'Argument':
        default:
          return action;
      }
    })
  }
  const minkeConfig = app._image == Images.MINKE;
  const adminMode = MinkeApp.getAdminMode();
  ctx.body = template({ minkeConfig: minkeConfig, adminMode: adminMode, skeleton: nskeleton, properties: JSON.stringify(properties), skeletonAsText: Skeletons.toString(skeleton),
    changes: '[' + Object.keys(visibles).map((key) => {
      return `function(){const c=document.getElementById("${key}").classList;try{if(${visibles[key]}){c.remove("invisible")}else{c.add("invisible")}}catch(_){}}`;
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

  let app = MinkeApp.getApps().find(item => item._id === ctx.params.id);

  const NOCHANGE = 0;
  const APPCHANGE = 1;
  const SKELCHANGE = 2;
  const SHARECHANGE = 4;

  function getTableData(app, name, value) {
    const skeleton = Skeletons.loadSkeleton(app._image, false);
    if (skeleton) {
      const action = skeleton.actions.find(action => action.name === name);
      if (action && (action.style === 'Table' || action.style === 'Websites')) {
        const table = JSON.parse(value);
        value = [];
        table.forEach((row) => {
          let line = action.pattern || '{{0}}';
          for (let i = 0; i < row.length; i++) {
            line = line.replace(new RegExp('\\{\\{' + i + '\\}\\}', 'g'), row[i]);
          }
          value.push(line);
        });
        return value.join('join' in action ? action.join : '\n');
      }
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
      const r = app._env[key] ? app._env[key] : { value: undefined };
      if (tableValue !== null) {
        r.altValue = value;
        if (r.value !== tableValue) {
          r.value = tableValue;
          const port = app._ports.find(p => p.target === key);
          if (port) {
            port.host = parseInt(r.value);
          }
          return APPCHANGE;
        }
      }
      else {
        delete r.altValue;
        if (r.value !== value) {
          r.value = value;
          const port = app._ports.find(p => p.target === key);
          if (port) {
            port.host = parseInt(r.value);
          }
          return APPCHANGE;
        }
      }
      return NOCHANGE;
    }},
    { p: /^NAT#(.+)$/, f: (value, match) => {
      const ports = match[1].split('#');
      let change = NOCHANGE;
      value = !!value;
      app._ports.forEach((port) => {
        if (ports.indexOf(port.target) !== -1) {
          if (port.nat !== value) {
            port.nat = value;
            change = APPCHANGE;
          }
        }
      });
      return change;
    }},
    { p: /^Network#(.+)$/, f: (value, match) => {
      const network = match[1];
      if ((network in app._networks) && app._networks[network] !== value) {
        app._networks[network] = value;
        return APPCHANGE;
      }
      return NOCHANGE;
    }},
    { p: /^File#(.+)$/, f: (value, match) => {
      const filename = match[1];
      const file = app._files.find(file => file.target === filename);
      if (file) {
        const tableValue = getTableData(app, filename, value);
        if (tableValue !== null) {
          if (file.data !== tableValue) {
            file.data = tableValue;
            file.altData = value;
            if (app._fs) {
              app._fs.makeFile(file);
            }
            return APPCHANGE;
          }
        }
        else {
          if (file.data !== value) {
            file.data = value;
            delete file.altData;
            if (app._fs) {
              app._fs.makeFile(file);
            }
            return APPCHANGE;
          }
        }
      }
      return NOCHANGE;
    }},
    { p: /^CustomShareables#(.+)$/, f: (value, match) => {
      const shareroot = match[1];
      const bind = {
        host: Path.normalize(`/dir/${shareroot}`),
        target: Path.normalize(shareroot),
        shares: JSON.parse(value).map((row) => {
          return { name: Path.normalize(`${row[0]}`) };
        })
      };
      if (app.updateCustomShare(bind)) {
        return SHARECHANGE;
      }
      return NOCHANGE;
    }},
    { p: /^Skeleton$/, f: (value, match) => {
      const skel = Skeletons.parse(value);
      if (skel) {
        Skeletons.saveSkeleton(skel);
        return SKELCHANGE;
      }
      return NOCHANGE;
    }}
  ];

  let changes = {};
  async function save() {
    try {
      let changed = 0;
      const shares = [];
      for (let property in changes) {
        patterns.find((pattern) => {
          const match = property.match(pattern.p);
          if (match) {
            changed |= pattern.f(changes[property], match);
            return true;
          }
          return false;
        });
        const match = property.match(/^Shareables#(.*)#(.*)#(.*)#(.*)$/);
        if (match) {
          shares.push({
            appid: match[1],
            host: match[2],
            root: match[3],
            target: changes[property].target.replace(/\//, '.') || match[4],
            shared: changes[property].shared
          });
        }
      }
      changes = {};

      const uapp = app;

      if (shares.length) {
        if (uapp.updateShares(shares)) {
          changed |= SHARECHANGE;
        }
      }
      if ((changed & SKELCHANGE) !== 0) {
        uapp.updateFromSkeleton(Skeletons.loadSkeleton(uapp._image, false), uapp.toJSON());
        app = null;
        send({
          type: 'page.reload'
        });
      }
      if (changed) {
        await uapp.restart();
      }
      else if (uapp._status === 'stopped') {
        await uapp.start();
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
        case 'app.save':
          if (app) {
            save();
          }
          break;
        case 'app.restart':
          if (app) {
            app.restart('restart');
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
          const uapp = app;
          app = null;
          uapp.uninstall();
          break;
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
