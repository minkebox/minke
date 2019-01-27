const FS = require('fs');
const Handlebars = require('handlebars');
const UUID = require('uuid/v4');
const MinkeApp = require('../MinkeApp');

function genDirectory(bind) {
  return {
    name: bind.target,
    shareable: bind.shareable,
    shared: bind.shared,
    description: bind.description || ''
  }
}

function genPort(port) {
  return {
    portnr: port.host,
    tcp: port.protocol === 'TCP',
    upnp: port.nat,
    mdns: !port.mdns ? {
      name: '',
      description: ''
    } : {
      name: port.mdns.type.split('.')[0],
      description: (port.mdns.txt && port.mdns.txt.description) || ''
    }
  }
}

function genFile(file) {
  return {
    target: file.target,
    data: file.data,
  }
}

function genMonitor(mon) {
  return {
    watch: mon.watch,
    polling: mon.polling,
    cmd: mon.cmd,
    parser: mon.parser,
    template: mon.template
  }
}

function genNetworks(app) {
  return {
    primary: app._networks.primary,
    secondary: app._networks.secondary === 'vpn' ? `vpn-${app._name}` : app._networks.secondary
  }
}

function mapNetwork(net) {
  return {
    name: net.name
  }
}

let template;

function registerTemplates() {
  Handlebars.registerHelper('index', (context) => {
    return 'index' in context.data ? context.data.index : context.data.root.index;
  });
  const partials = [
    'Directory',
    'Port',
    'Monitor',
    'File',
    'Features',
    'Networks',
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
  template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Settings.html`, { encoding: 'utf8' }));
}

async function SettingsPageHTML(ctx) {

  registerTemplates();

  const app = MinkeApp.getApps().find((item) => {
    return item._name === ctx.params.id;
  })
  ctx.body = template({ editmode: false, app: {
    name: app._name,
    image: app._image,
    description: app._description || '',
    arguments: app._args || '',
    environment: (app._env || '').join(':'),
    features: app._features,
    directories: app._binds.map(bind => genDirectory(bind)),
    ports: app._ports.map(port => genPort(port)),
    monitor: genMonitor(app._monitor),
    files: app._files.map(file => genFile(file)),
    networks: genNetworks(app),
  }, networks: [{ name: 'none' }].concat(MinkeApp.getNetworks().map(net => mapNetwork(net)))});
  ctx.type = 'text/html';
}

async function SettingsPageWS(ctx) {

  const app = MinkeApp.getApps().find((item) => {
    return item._name === ctx.params.id;
  });
  let changed = false;

  const patterns = [
    { p: /^app.name$/, f: (msg, match) => {
      app._name = msg.value;
    }},
    { p: /^app.image$/, f: (msg, match) => {
      app._image = msg.value;
    }},
    { p: /^app.description$/, f: (msg, match) => {
        app._description = msg.value;
    }},
    { p: /^app.arguments$/, f: (msg, match) => {
      app._args = msg.value;
    }},
    { p: /^app.environment$/, f: (msg, match) => {
      if (msg.value.trim()) {
        app._env = msg.value.split(':');
      }
      else {
        app._env = [];
      }
    }},
    { p: /^app.features.(.+)$/, f: (msg, match) => {
      app._features[match[1]] = msg.value;
    }},
    { p: /^app.directories\[(\d+)\].name$/, f: (msg, match) => {
        const bind = app._binds[parseInt(match[1])];
        bind.target = msg.value.trim();
        bind.host = `/dir/${bind.target}`;
    }},
    { p: /^app.directories\[(\d+)\].description$/, f: (msg, match) => {
        app._binds[parseInt(match[1])].description = msg.value;
    }},
    { p: /^app.directories\[(\d+)\].shareable$/, f: (msg, match) => {
        app._binds[parseInt(match[1])].shareable = msg.value;
    }},
    { p: /^app.directories\[(\d+)\].shared$/, f: (msg, match) => {
        app._binds[parseInt(match[1])].shared = msg.value;
    }},
    { p: /^app.ports\[(\d+)\].portnr$/, f: (msg, match) => {
        const port = app._ports[parseInt(match[1])];
        port.host = parseInt(msg.value);
        port.target = `${port.host}/${port.protocol.toLowerCase()}`;
    }},
    { p: /^app.ports\[(\d+)\].protocol$/, f: (msg, match) => {
        const port = app._ports[parseInt(match[1])];
        port.protocol = msg.value == 'UDP' ? 'UDP' : 'TCP';
        port.target = `${port.host}/${port.protocol.toLowerCase()}`;
    }},
    { p: /^app.ports\[(\d+)\].upnp$/, f: (msg, match) => {
        app._ports[parseInt(match[1])].nat = msg.value;
    }},
    { p: /^app.ports\[(\d+)\].mdns.name$/, f: (msg, match) => {
        const port = app._ports[parseInt(match[1])];
        port.mdns.type = `${msg.value}._${port.protocol.toLowerCase()}`;
    }},
    { p: /^app.ports\[(\d+)\].mdns.description$/, f: (msg, match) => {
        const port = app._ports[parseInt(match[1])];
        if (!port.mdns.txt) {
          port.mdns.txt = {};
        }
        if (msg.value) {
          port.mdns.txt.description = msg.value;
        }
        else {
          delete port.mdns.txt.description;
        }
    }},
    { p: /^app.monitor.watch$/, f: (msg, match) => {
        app._monitor.watch = msg.value.trim();
    }},
    { p: /^app.monitor.polling$/, f: (msg, match) => {
        app._monitor.polling = parseFloat(msg.value) || 0;
    }},
    { p: /^app.monitor.cmd$/, f: (msg, match) => {
        app._monitor.cmd = msg.value.trim();
    }},
    { p: /^app.monitor.parser$/, f: (msg, match) => {
      if (msg.value.trim()) {
        app._monitor.parser = msg.value;
      }
      else {
        app._monitor.parser = '';
      }
    }},
    { p: /^app.monitor.template$/, f: (msg, match) => {
        if (msg.value.trim()) {
          app._monitor.template = msg.value;
        }
        else {
          app._monitor.template = '';
        }
    }},
    { p: /^app.files\[(\d+)\].target$/, f: (msg, match) => {
      app._files[parseInt(match[1])].target = msg.value;
    }},
    { p: /^app.files\[(\d+)\].data$/, f: (msg, match) => {
      if (msg.value.trim()) {
        app._files[parseInt(match[1])].data = msg.value;
      }
      else {
        app._files[parseInt(match[1])].data = '';
      }
    }},
    { p: /^app.networks.primary.name$/, f: (msg, match) => {
      app._networks.primary = msg.value;
      app.emit('update.network.config', { app: app, primary: msg.value });
    }},
    { p: /^app.networks.secondary.name$/, f: (msg, match) => {
      app._networks.secondary = msg.value;
      app.emit('update.network.config', { app: app, secondary: msg.value });
    }},
  ];

  ctx.websocket.on('message', (msg) => {
    //console.log(msg);
    try {
      msg = JSON.parse(msg);
      switch (msg.type) {
        case 'settings.change':
        {
          const property = msg.property;
          patterns.find((pattern) => {
            let match = property.match(pattern.p);
            if (match) {
              pattern.f(msg, match);
              changed = true;
              return true;
            }
            return false;
          });
          break;
        }
        case 'settings.port.add':
        {
          const newPort = {
            target: '80/tcp',
            host: 80,
            protocol: 'TCP',
            nat: false,
            mdns: {
              type: '._tcp',
              txt: {
                description: ''
              }
            }
          };
          const html = Handlebars.compile('{{> Port}}')(Object.assign({
            editmode: true,
            index: app._ports.length
          }, genPort(newPort)));
          try {
            ctx.websocket.send(JSON.stringify({
              type: 'html.append',
              selector: '.settings .ports .portset',
              html: html
            }));
            app._ports.push(newPort);
            changed = true;
          }
          catch (_) {
          }
          break;
        }
        case 'settings.port.rm':
        {
          try {
            ctx.websocket.send(JSON.stringify({
              type: 'html.truncate',
              selector: '.settings .ports .portset'
            }));
            app._ports.splice(-1, 1);
            changed = true;
          }
          catch (_) {
          }
          break;
        }
        case 'settings.directory.add':
        {
          const newDir = {
            host: '/dir',
            target: '/',
            shareable: false,
            description: ''
          };
          const html = Handlebars.compile('{{> Directory}}')(Object.assign({
            editmode: true,
            index: app._binds.length
          }, genDirectory(newDir)));
          try {
            ctx.websocket.send(JSON.stringify({
              type: 'html.append',
              selector: '.settings .bindings .bindset',
              html: html
            }));
            app._binds.push(newDir);
            changed = true;
          }
          catch (_) {
          }
          break;
        }
        case 'settings.directory.rm':
        {
          try {
            ctx.websocket.send(JSON.stringify({
              type: 'html.truncate',
              selector: '.settings .bindings .bindset'
            }));
            app._binds.splice(-1, 1);
            changed = true;
          }
          catch (_) {
          }
          break;
        }
        case 'settings.file.add':
        {
          const newFile = {
            host: `/file/${UUID()}`,
            target: '',
            data: ''
          };
          const html = Handlebars.compile('{{> File}}')(Object.assign({
            editmode: true,
            index: app._files.length
          }, genFile(newFile)));
          try {
            ctx.websocket.send(JSON.stringify({
              type: 'html.append',
              selector: '.settings .files .fileset',
              html: html
            }));
            app._files.push(newFile);
            changed = true;
          }
          catch (_) {
          }
          break;
        }
        case 'settings.file.rm':
        {
          try {
            ctx.websocket.send(JSON.stringify({
              type: 'html.truncate',
              selector: '.settings .files .fileset'
            }));
            app._files.splice(-1, 1);
            changed = true;
          }
          catch (_) {
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
    if (changed) {
      app.restart(true);
    }
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });
}

module.exports = {
  HTML: SettingsPageHTML,
  WS: SettingsPageWS
};
