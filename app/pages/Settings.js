const FS = require('fs');
const Handlebars = require('handlebars');
const MinkeApp = require('../MinkeApp');

Handlebars.registerHelper('index', (context) => {
  return 'index' in context.data ? context.data.index : context.data.root.index;
});

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

function genMonitor(mon) {
  return {
    watch: mon.watch,
    polling: mon.polling,
    cmd: mon.cmd,
    parser: mon.parser,
    template: mon.template
  }
}

function registerPartials() {
  const partials = [
    'Directory',
    'Port',
    'Monitor'
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }));
  });
}

async function SettingsPageHTML(ctx) {

  const template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Settings.html`, { encoding: 'utf8' }));
  registerPartials();

  const app = MinkeApp.getApps().find((item) => {
    return item._name === ctx.params.id;
  })
  ctx.body = template({ editmode: false, app: {
    name: app._name,
    image: app._image,
    description: app._description || '',
    directories: app._binds.map(bind => genDirectory(bind)),
    ports: app._ports.map(port => genPort(port)),
    monitor: genMonitor(app._monitor)
  }});
  ctx.type = 'text/html';
}

async function SettingsPageWS(ctx) {

  const app = MinkeApp.getApps().find((item) => {
    return item._name === ctx.params.id;
  });
  let changed = false;

  const patterns = [
    { p: /^app.name$/, f: (msg, match) => {
    }},
    { p: /^app.description$/, f: (msg, match) => {
        app._description = msg.value;
    }},
    { p: /^app.directories\[(\d+)\].name$/, f: (msg, match) => {
        const bind = app._binds[parseInt(match[1])];
        bind.host = msg.value.trim();
        bind.target = bind.host;
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
        app._monitor.polling = parseFloat(msg.value);
    }},
    { p: /^app.monitor.cmd$/, f: (msg, match) => {
        app._monitor.cmd = msg.value.trim();
    }},
    { p: /^app.monitor.parser$/, f: (msg, match) => {
        app._monitor.parser = msg.value;
    }},
    { p: /^app.monitor.template$/, f: (msg, match) => {
        app._monitor.template = msg.value;
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
            host: '/',
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
