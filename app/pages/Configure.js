const FS = require('fs');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');
const Skeletons = require('../skeletons/Skeletons');

let template;
function registerTemplates() {
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

  const env = app._env.reduce((acc, key) => {
    const kv = key.split('=');
    acc[kv[0]] = kv[1];
    return acc;
  }, {});

  const nskeleton = {
    name: skeleton.name,
    value: app._name,
    description: skeleton.description,
    actions: skeleton.actions.map((action) => {
      switch (action.type) {
        case 'Environment':
        {
          return Object.assign({ action: `action('${action.type}.${action.name}',this.value)`, value: env[action.name] }, action);
        }
        case 'Share':
        {
          const bind = app._binds.find(bind => bind.target === action.name) || { shared: false };
          return Object.assign({ action: `action('${action.type}.${action.name}',this.checked)`, value: bind.shared }, action);
        }
        case 'NAT':
        {
          const natport = app._ports.find(port => action.ports.indexOf(port.target) !== -1) || { nat: false };
          return Object.assign({ action: `action('${action.type}.${action.ports.join(".")}',this.checked)`, value: natport.nat }, action);
        }
        case 'Network':
        {
          const networks = [ { name: 'none' } ].concat(MinkeApp.getNetworks());
          const network = app._networks[action.name] || 'none'
          return Object.assign({ action: `action('${action.type}.${action.name}',this.value)`, networks: networks, value: network }, action);
        }
        case 'Feature':
        {
          return Object.assign({ action: `action('${action.type}.${action.name}',this.checked)`, value: app._features[action.name] || false }, action);
        }
        case 'Argument':
        case 'File':
        default:
          return action;
      }
    })
  }
  ctx.body = template({ skeleton: nskeleton, skeletonAsText: Skeletons.toString(skeleton) });
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

  const app = MinkeApp.getApps().find(item => item._id === ctx.params.id);

  const NOCHANGE = 0;
  const APPCHANGE = 1;
  const SKELCHANGE = 2;

  const patterns = [
    { p: /^Name$/, f: (value, match) => {
      if (app._name != value) {
        app._name = value;
        return APPCHANGE;
      }
      return NOCHANGE;
    }},
    { p: /^Feature\.(.+)$/, f: (value, match) => {
      const feature = match[1];
      if ((feature in app._features) && app._features[feature] !== value) {
        app._features[feature] = value;
        return APPCHANGE;
      }
      return NOCHANGE;
    }},
    { p: /^Environment\.(.+)$/, f: (value, match) => {
      const key = `${match[1]}=`;
      const idx = app._env.findIndex(env => env.indexOf(key) === 0);
      if (idx !== -1) {
        if (app._env[idx] !== `${key}${value}`) {
          app._env[idx] = `${key}${value}`;
          return APPCHANGE;
        }
      }
      return NOCHANGE;
    }},
    { p: /^Share\.(.+)$/, f: (value, match) => {
      const key = match[1];
      value = !!value;
      const bind = app._binds.find(bind => bind.target === key);
      if (bind) {
        if (value !== bind.shared) {
          bind.shareable = value;
          bind.shared = value;
          return APPCHANGE;
        }
      }
      return NOCHANGE;
    }},
    { p: /^NAT\.(.+)$/, f: (value, match) => {
      const ports = match[1].split('.');
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
    { p: /^Network\.(.+)$/, f: (value, match) => {
      const network = match[1];
      if ((network in app._networks) && app._networks[network] !== value) {
        app._networks[network] = value;
        return APPCHANGE;
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
  function save() {
    let changed = 0;
    for (let property in changes) {
      patterns.find((pattern) => {
        let match = property.match(pattern.p);
        if (match) {
          changed |= pattern.f(changes[property], match);
          return true;
        }
        else {
          return false;
        }
      });
    }
    changes = {};
    
    if ((changed & SKELCHANGE) !== 0) {
      app.updateFromSkeleton(Skeletons.loadSkeleton(app._image));
      send({
        type: 'page.reload'
      });
    }
    if (changed) {
      app.restart(true);
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
          save();
          break;
        case 'app.delete':
          changes = {};
          app.uninstall();
          break;
        default:
          break;
      }
    }
    catch (_) {
    }
  });

  ctx.websocket.on('close', () => {
    save();
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
