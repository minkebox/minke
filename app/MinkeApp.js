const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const HTTPForward = require('./HTTPForward');
const DNSForward = require('./DNSForward');
const Network = require('./Network');
const Filesystem = require('./Filesystem');
const Database = require('./Database');
const Render = require('./Render');

const DEBUG = !!process.env.DEBUG;

const MINKE_HELPER_IMAGE = 'timwilkinson/minke-helper';

const TCP_HTTP = '80/tcp';
const TCP_DNS = '53/udp';
const UDP_DNS = '53/udp';

const applications = {};
let koaApp = null;

function MinkeApp() {
  EventEmitter.call(this);
}

MinkeApp.prototype = {

  createFromConfig: async function(config) {
    
    this._name = config.name;
    this._image = config.image;
    this._env = config.env || [];

    const image = await docker.getImage(this._image);
    const imageInfo = await image.inspect();
    const containerConfig = imageInfo.ContainerConfig;

    if (config.type === 'map') {
      const portmap = config.portmap || {};
      this._ports = Object.keys(containerConfig.ExposedPorts).map((port) => {
        return {
          name: `${this._name}:${port}`,
          target: port,
          host: (portmap[port] && portmap[port].port) || parseInt(port),
          protocol: port.split('/')[1].toLocaleUpperCase(),
          nat: (portmap[port] && portmap[port].nat) || false
        }
      });
    }
    else {
      this._ports = [];
    }

    this._binds = [];
    if (containerConfig.Volumes || config.fsmap) {
      const fsmap = config.fsmap || {};
      const fs = Filesystem.createAppFS(this);
      const volumes = Object.assign({}, containerConfig.Volumes, config.fsmap);
      for (let path in volumes) {
        const map = fsmap[path];
        if (!map || map.type === 'private') {
          this._binds.push(fs.mapPrivateVolume(path));
        }
        else {
          this._binds.push(fs.mapShareableVolume(path));
        }
      }
    }

    // Host's need their own real ip addresses
    if (config.type === 'host') {
      this._ip4 = true;
    }
    else {
      this._ip4 = false;
    }
  
    this._needLink = !!containerConfig.ExposedPorts[TCP_HTTP];
    this._needDNS = !!(containerConfig.ExposedPorts[TCP_DNS] && containerConfig.ExposedPorts[UDP_DNS]);

    return this;
  },

  createFromJSON: function(app) {

    this._name = app.name;
    this._image = app.image;
    this._env = app.env;
    this._ports = app.ports;
    this._binds = app.binds;
    this._ip4 = app.ip4;
    this._needLink = app.link;
    this._needDNS = app.dns;

    return this;
  },

  toJSON: function() {
    return {
      name: this._name,
      image: this._image,
      env: this._env,
      link: this._needLink,
      dns: this._needDNS,
      ip4: this._ip4,
      ports: this._ports,
      binds: this._binds
    }
  },

  start: async function() {

    this.emit('starting');
  
    // Build the helper
    this._fs = Filesystem.createAppFS(this);
  
    const config = {
      name: this._name,
      Hostname: `minke-${this._name}`,
      Image: this._image, // Use the human-readable name
      HostConfig: {
        Mounts: this._fs.getAllMounts(),
        //Privileged: true,
        AutoRemove: true
      },
      Env: this._env
    };

    // If we don't have our own IP, then we might need to forward some ports
    if (!this._ip4) {
      config.PortBindings = Object.assign.apply({}, [{}].concat(this._ports.map((port) => {
        return { [port.target]: [{ HostPort: port.host }] }
      })));
    }

    // Primary network is the host network, not the bridge
    if (this._ip4) {
      const hostnet = await Network.getHostNetwork();
      config.HostConfig.NetworkMode = hostnet.id;
    }

    if (DEBUG) {
      config.StopTimeout = 1;
    }
  
    const helperConfig = {
      name: `${this._name}-helper`,
      Hostname: config.Hostname,
      Image: MINKE_HELPER_IMAGE,
      HostConfig: {
        NetworkMode: config.HostConfig.NetworkMode,
        AutoRemove: true,
        CapAdd: [ 'NET_ADMIN' ],
        //Privileged: true
      },
      Env: []
    };

    if (this._ip4) {
      helperConfig.Env.push('ENABLE_DHCP=1');
    }
  
    if (this._ports.length) {
      const nat = [];
      this._ports.map((port) => {
        if (port.nat) {
          nat.push(`${port.host}:${port.protocol}`);
        }
      });
      if (nat.length) {
        helperConfig.Env.push(`ENABLE_NAT=${nat.join(' ')}`);
      }
    }

    applications[this._name] = this;

    if (helperConfig.Env.length) {
      this._helperContainer = await docker.createContainer(helperConfig);

      config.Hostname = null;
      config.HostConfig.NetworkMode = `container:${this._helperContainer.id}`;

      await this._helperContainer.start();

      if (this._ip4) {
        const bridge = await Network.getBridgeNetwork();
        await bridge.connect({
          Container: this._helperContainer.id
        });
      }

      // Wait while the helper configures everything.
      const log = await this._helperContainer.logs({
        follow: true,
        stdout: true,
        stderr: false
      });
      await new Promise((resolve) => {
        docker.modem.demuxStream(log, {
          write: (data) => {
            if (data.toString('utf8').indexOf('MINKE:UP') !== -1) {
              log.destroy();
              resolve();
            }
          }
        }, null);
      });
    }

    this._container = await docker.createContainer(config);
    await this._container.start();

    const containerInfo = await (this._helperContainer || this._container).inspect();
    const bridgeIP4Address = containerInfo.NetworkSettings.Networks.bridge.IPAddress;
    if (this._needLink) {
      this._forward = HTTPForward.createForward({ prefix: `/a/${this._name}`, IP4Address: bridgeIP4Address, port: parseInt(TCP_HTTP) });
      koaApp.use(this._forward.http);
      koaApp.ws.use(this._forward.ws);
    }
    if (this._needDNS) {
      this._dns = DNSForward.createForward({ name: this._name, IP4Address: bridgeIP4Address });
    }

    this.emit('started');

    return this;
  },

  stop: async function() {

    this.emit('stopping');

    if (this._dns) {
      DNSForward.removeForward(this._dns);
    }

    if (this._forward) {
      const idx = koaApp.middleware.indexOf(this._forward.http);
      if (idx !== -1) {
        koaApp.middleware.splice(idx, 1);
      }
      const widx = koaApp.ws.middleware.indexOf(this._forward.ws);
      if (widx !== -1) {
        koaApp.ws.middleware.splice(widx, 1);
      }
    }

    if (this._helperContainer) {
      try {
        await this._helperContainer.stop();
      }
      catch (_) {
      }
    }

    try {
      await this._container.stop();
    }
    catch (_) {
    }

    delete applications[this._name];

    this.emit('stopped');

    return this;
  },

  save: async function() {
    await Database.saveApp(this);
    return this;
  }, 

  _test: async function() {
    // date,ping,down,up
    this._createStatusRenderer({
      watch: '/var/www/html/data/result.csv',
      cmd: 'tail -1 /var/www/html/data/result.csv', 
      parser: `const args = input.split(',');
      output = {
        date: new Date(args[0]),
        pingMs: parseFloat(args[1]),
        downloadMB: parseFloat(args[2]),
        uploadMB: parseFloat(args[3])
      }`,
      template: '<div>Ping: {{ping}} ms</div><div>Download: {{downloadMB}} MB/s</div><div>Upload: {{uploadMB}} MB/s</div>'
    });
  },

  _createStatusRenderer: async function(args) {
    this._statusRender = Render.create({
      app: this,
      cmd: args.cmd,
      parser: args.parser,
      template: args.template,
      watch: args.watch,
      callback: (html) => {
        this._statusHTML = html;
        this.emit('status.update', { app: this, html: this._statusHTML });
      }
    });
    this._statusHTML = await this._statusRender.run();
    this.emit('status.update', { app: this, html: this._statusHTML });
  }

}
Util.inherits(MinkeApp, EventEmitter);

MinkeApp.startApps = async function(app) {

  koaApp = app;

  // Start DB
  await Database.init();

  // Find ourself
  (await docker.listContainers({})).forEach((container) => {
    if (container.Image.endsWith('/minke')) {
      container.Mounts.forEach((mount) => {
        if (mount.Type === 'bind' && mount.Destination === '/minke') {
          Filesystem.setHostPrefix(mount.Source);
        }
      })
    }
  });

  // Start all the apps
  const running = await docker.listContainers();
  const runningNames = running.map(container => container.Names[0]);
  const apps = await Database.getApps();
  await Promise.all(apps.map(async (info) => {
    const app = new MinkeApp().createFromJSON(info);
    // Stop if running
    let idx = runningNames.indexOf(`/${app._name}`);
    if (idx !== -1) {
      await (await docker.getContainer(running[idx].Id)).stop();
    }
    idx = runningNames.indexOf(`/${app._name}-helper`);
    if (idx !== -1) {
      await (await docker.getContainer(running[idx].Id)).stop();
    }
    await app.start();
  }));
}

MinkeApp.shutdown = async function() {
  return Promise.all(Object.values(applications).map(async (app) => {
    await app.stop();
    await app.save();
  }));
}

MinkeApp.getRunningApps = function() {
  return applications;
}

module.exports = MinkeApp;
