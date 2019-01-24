const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const HTTPForward = require('./HTTPForward');
const DNSForward = require('./DNSForward');
const Network = require('./Network');
const Filesystem = require('./Filesystem');
const Database = require('./Database');
const Monitor = require('./Monitor');

const DEBUG = !!process.env.DEBUG;

const MINKE_HELPER_IMAGE = 'timwilkinson/minke-helper';

const TCP_HTTP = '80/tcp';
const TCP_DNS = '53/udp';
const UDP_DNS = '53/udp';

let applications = null;
let koaApp = null;

function MinkeApp() {
  EventEmitter.call(this);
  this._setupUpdateListeners();
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
          description: '',
          target: port,
          host: (portmap[port] && portmap[port].port) || parseInt(port),
          protocol: port.split('/')[1].toLocaleUpperCase(),
          nat: (portmap[port] && portmap[port].nat) || false,
          mdns: null
        }
      });
    }
    else {
      this._ports = [];
    }

    this._binds = [];
    if (containerConfig.Volumes || config.fsmap) {
      const fsmap = config.fsmap || {};
      const fs = Filesystem.create(this);
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

    this._needDNS = !!(containerConfig.ExposedPorts[TCP_DNS] && containerConfig.ExposedPorts[UDP_DNS]);
    this._needLink = false;

    // Select the relevant network config.
    switch (config.type) {
      case 'home':
        // Connect to home network and default bridge.
        this._ip4 = [ 'home', 'bridge' ];
        break;

      case 'vpn':
        // Connect to home network and a user-defined bridge (used for vpn)
        this._ip4 = [ 'home', 'vpn' ];
        break;

      default:
        this._ip4 = [ 'bridge' ];
        this._needLink = !!containerConfig.ExposedPorts[TCP_HTTP];
        break;
    }

    this._setOnline(false);

    return this;
  },

  createFromJSON: function(app) {

    this._name = app.name;
    this._description = app.description;
    this._image = app.image;
    this._env = app.env;
    this._ports = app.ports;
    this._binds = app.binds;
    this._ip4 = app.ip4;
    this._needLink = app.link;
    this._needDNS = app.dns;
    this._monitor = app.monitor || {};

    this._setOnline(false);

    return this;
  },

  toJSON: function() {
    return {
      name: this._name,
      description: this._description,
      image: this._image,
      env: this._env,
      link: this._needLink,
      dns: this._needDNS,
      ip4: this._ip4,
      ports: this._ports,
      binds: this._binds,
      monitor: this._monitor
    }
  },

  start: async function() {

    let needHomeNetwork = this._ip4.indexOf('home') !== -1;
    const needBridgeNetwork = this._ip4.indexOf('bridge') !== -1;
    const needPrivateNetwork = this._ip4.indexOf('vpn') !== -1;
    const usePrivateNetwork = this._ip4.find(net => net.indexOf('vpn-') === 0);

    // HACK
    if (!needPrivateNetwork && !usePrivateNetwork) needHomeNetwork = true;

    // Build the helper
    this._fs = Filesystem.create(this);
  
    const config = {
      name: this._name,
      Hostname: `minke-${this._name}`,
      Image: this._image, // Use the human-readable name
      HostConfig: {
        Mounts: this._fs.getAllMounts(),
        AutoRemove: true,
        Devices: [],
        CapAdd: []
      },
      Env: [].concat(this._env)
    };

    // Share filesystems
    this._binds.forEach((map) => {
      this._fs.shareVolume(map);
    });

    // If we don't have our own IP, then we might need to forward some ports
    if (!this._ip4) { // XXX FIX ME XXX
      config.PortBindings = {}
      this._ports.forEach((port) => {
        if (port.target && parseInt(port.host)) {
          config.PortBindings[port.target] = [{ HostPort: port.host }];
        }
      });
    }

    // If we need the home network, we set that up as primary
    if (needHomeNetwork) {
      const homenet = await Network.getHomeNetwork();
      config.HostConfig.NetworkMode = homenet.id;
    }
    // Alternatively, if we're using a private network we set that as primary
    else if (usePrivateNetwork) {
      const vpn = await Network.getPrivateNetwork(usePrivateNetwork);
      config.HostConfig.NetworkMode = vpn.id;
      const info = await vpn.inspect();
      const gw = info.IPAM.Config[0].Gateway.replace(/.\d$/,'.2');
      config.HostConfig.ExtraHosts = [
        `SERVICES:${gw}`
      ];
      config.HostConfig.Dns = [ gw ];
      config.HostConfig.DnsSearch = [ 'local.' ];
      config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:1', 'attempts:1' ];
    }

    if (needPrivateNetwork) {
      config.HostConfig.Devices.push({
        PathOnHost: '/dev/net/tun',
        PathInContainer: '/dev/net/tun',
        CgroupPermissions: 'rwm'
      });
      config.HostConfig.CapAdd.push('NET_ADMIN');
    }

    if (DEBUG) {
      config.StopTimeout = 1;
    }
  
    const helperConfig = {
      name: `helper-${this._name}`,
      Hostname: config.Hostname,
      Image: MINKE_HELPER_IMAGE,
      HostConfig: {
        NetworkMode: config.HostConfig.NetworkMode,
        AutoRemove: true,
        CapAdd: [ 'NET_ADMIN' ],
        ExtraHosts: config.HostConfig.ExtraHosts,
        Dns: config.HostConfig.Dns,
        DnsSearch: config.HostConfig.DnsSearch,
        DnsOptions: config.HostConfig.DnsOptions
      },
      Env: []
    };

    if (needHomeNetwork) {
      helperConfig.Env.push('ENABLE_DHCP=1');
    }

    if (this._ports.length) {
      const nat = [];
      const mdns = [];
      this._ports.forEach((port) => {
        if (port.nat) {
          nat.push(`${port.host}:${port.protocol}`);
        }
        if (port.mdns && port.mdns.type && port.mdns.type.split('.')[0]) {
          mdns.push(`${port.mdns.type}:${port.host}:` + (!port.mdns.txt ? '' : Object.keys(port.mdns.txt).map((key) => {
            if (port.mdns.txt[key]) {
              return `<txt-record>${key}=${port.mdns.txt[key].replace(/ /g, '%20')}</txt-record>`
            }
            else {
              return '';
            }
          }).join('')));
        }
      });
      if (nat.length) {
        helperConfig.Env.push(`ENABLE_NAT=${nat.join(' ')}`);
      }
      if (mdns.length) {
        helperConfig.Env.push(`ENABLE_MDNS=${mdns.join(' ')}`);
      }
    }
  
    if (helperConfig.Env.length) {
      this._helperContainer = await docker.createContainer(helperConfig);

      config.Hostname = null;
      config.HostConfig.ExtraHosts = null;
      config.HostConfig.Dns = null;
      config.HostConfig.DnsSearch = null;
      config.HostConfig.DnsOptions = null;
      config.HostConfig.NetworkMode = `container:${this._helperContainer.id}`;

      await this._helperContainer.start();

      if (needBridgeNetwork) {
        const bridge = await Network.getBridgeNetwork();
        await bridge.connect({
          Container: this._helperContainer.id
        });
      }
      if (needPrivateNetwork) {
        const vpn = await Network.getPrivateNetwork(`vpn-${this._name}`);
        await vpn.connect({
          Container: this._helperContainer.id
        });
      }
      // Attach the private network if we already didn't use it as the primary
      if (usePrivateNetwork && needHomeNetwork) {
        const vpn = await Network.getPrivateNetwork(usePrivateNetwork);
        await vpn.connect({
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
    if (this._needLink) {
      this._forward = HTTPForward.createForward({ prefix: `/a/${this._name}`, IP4Address: containerInfo.NetworkSettings.Networks.bridge.IPAddress, port: parseInt(TCP_HTTP) });
      koaApp.use(this._forward.http);
      koaApp.ws.use(this._forward.ws);
    }
    if (this._needDNS) {
      this._dns = DNSForward.createForward({ name: this._name, IP4Address: containerInfo.NetworkSettings.Networks.bridge.IPAddress });
    }

    if (needPrivateNetwork) {
      this._monitorNetwork();
    }

    if (this._monitor.cmd) {
      this._statusMonitor = this._createMonitor({
        event: 'update.status',
        polling: this._monitor.polling,
        cmd: this._monitor.cmd,
        watch: this._monitor.watch,
        parser: this._monitor.parser,
        template: this._monitor.template
      });
    }

    this._setOnline(true);

    return this;
  },

  stop: async function() {
  
    try {
      if (this._statusMonitor) {
        this._statusMonitor.stop();
        this._statusMonitor = null;
      }
    }
    catch (_) {
    }
    try {
      this._networkMonitor.stop();
      this._networkMonitor = null;
    }
    catch (_) {
    }

    this._fs.unshareVolumes();

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

    const stopping = [];
    if (this._helperContainer) {
      stopping.push(this._helperContainer.stop());
    }
    if (this._container) {
      stopping.push(this._container.stop());
    }
    try {
      await Promise.all(stopping);
    }
    catch (_) {
    }

    this._setOnline(false);

    return this;
  },

  restart: async function(save) {
    await this.stop();
    if (save) {
      await this.save();
    }
    await this.start();
  },

  save: async function() {
    await Database.saveApp(this);
    return this;
  },

  _monitorNetwork: function() {
    this._networkMonitor = this._createMonitor({
      event: 'update.network.status',
      polling: 10,
      watch: '/etc/status/mdns-output.json',
      cmd: 'cat /etc/status/mdns-output.json', 
      parser: 'output = JSON.parse(input || "{}")'
    });
  },

  _createMonitor: function(args) {  
    const monitor = Monitor.create({
      app: this,
      cmd: args.cmd,
      parser: args.parser,
      template: args.template,
      watch: args.watch,
      polling: args.polling,
      callback: async (data) => {
        this._emit(args.event, { data: await data });
      }
    });

    this._eventState[args.event] = {
      data: '',
      start: async () => {
        this._emit(args.event, { data: await monitor.run() });
      },
      stop: async () => {
        await monitor.stop();
      }
    };

    if (this.listenerCount(args.event) > 0) {
      this._eventState[args.event].start();
    }

    return monitor;
  },

  _setOnline: function(online) {
    if (this._online === online) {
      return;
    }
    this._online = online;
    this._emit('update.online', { online: online });
  },

  _setupUpdateListeners: function() {

    this._eventState = {};

    this.on('newListener', async (event, listener) => {
      const state = this._eventState[event];
      if (state) {
        if (this.listenerCount(event) === 0 && state.start) {
          await state.start();
        }
        listener(state.data);
      }
    });

    this.on('removeListener', async (event, listener) => {
      const state = this._eventState[event];
      if (state) {
        if (this.listenerCount(event) === 0 && state.stop) {
          await state.stop();
        }
      }
    });
  },

  _emit: function(event, data) {
    if (!this._eventState[event]) {
      this._eventState[event] = {};
    }
    data.app = this;
    this._eventState[event].data = data;
    this.emit(event, data);
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

  const running = await docker.listContainers();
  const runningNames = running.map(container => container.Names[0]);

  // Load all the apps
  applications = (await Database.getApps()).map((json) => {
    return new MinkeApp().createFromJSON(json);
  });

  // Stop apps if they're still running
  await Promise.all(applications.map(async (app) => {
    let idx = runningNames.indexOf(`/${app._name}`);
    if (idx !== -1) {
      await (await docker.getContainer(running[idx].Id)).stop();
    }
    idx = runningNames.indexOf(`/helper-${app._name}`);
    if (idx !== -1) {
      await (await docker.getContainer(running[idx].Id)).stop();
    }
  }));
  // Start all app which are not connected to a private network first
  await Promise.all(applications.map(async (app) => {
    const usePrivateNetwork = app._ip4.find(net => net.indexOf('vpn-') === 0);
    if (!usePrivateNetwork) {
      await app.start();
    }
  }));
  // Then start the apps which are connected to the private networks
  await Promise.all(applications.map(async (app) => {
    const usePrivateNetwork = app._ip4.find(net => net.indexOf('vpn-') === 0);
    if (usePrivateNetwork) {
      await app.start();
    }
  }));
}

MinkeApp.shutdown = async function() {
  await Promise.all(applications.map(async (app) => {
    await app.stop();
    await app.save();
  }));
}

MinkeApp.getApps = function() {
  return applications;
}

module.exports = MinkeApp;
