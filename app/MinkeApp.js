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

  createFromJSON: function(app) {

    this._name = app.name;
    this._description = app.description;
    this._image = app.image;
    this._args = app.args;
    this._env = app.env;
    this._features = app.features || {},
    this._ports = app.ports;
    this._binds = app.binds;
    this._files = app.files || [];
    this._networks = app.networks;
    this._monitor = app.monitor || {};

    this._setOnline(false);

    return this;
  },

  toJSON: function() {
    return {
      name: this._name,
      description: this._description,
      image: this._image,
      args: this._args,
      env: this._env,
      features: this._features,
      networks: this._networks,
      ports: this._ports,
      binds: this._binds,
      files: this._files,
      monitor: this._monitor
    }
  },

  start: async function() {

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
    /*if (!this._ip4) { // XXX FIX ME XXX
      config.PortBindings = {}
      this._ports.forEach((port) => {
        if (port.target && parseInt(port.host)) {
          config.PortBindings[port.target] = [{ HostPort: port.host }];
        }
      });
    }*/

    // Create network environment
    let netid = 0;
    let man = false;
    switch (this._networks.primary || 'none') {
      case 'none':
        if (this._features.web || this._features.dns) {
          config.Env.push(`__MANAGEMENT_INTERFACE=eth${netid++}`);
          man = true;
        }
        break;
      case 'home':
        config.Env.push(`__HOME_INTERFACE=eth${netid++}`);
        break;
      case 'vpn':
        console.error('vpn cannot be primary network');
        break;
      default:
        if (this._networks.primary.startsWith('vpn-')) {
          config.Env.push(`__PRIVATE_INTERFACE=eth${netid++}`);
        }
        break;
    }
    if ((this._networks.primary || 'none') !== 'none') {
      switch (this._networks.secondary || 'none') {
        case 'none':
          break;
        case 'home':
          config.Env.push(`__HOME_INTERFACE=eth${netid++}`);
          break;
        case 'vpn':
          config.Env.push(`__PRIVATE_INTERFACE=eth${netid++}`);
          break;
        default:
          if (this._networks.secondary.startsWith('vpn-')) {
            config.Env.push(`__PRIVATE_INTERFACE=eth${netid++}`);
          }
          break;
      }
      if ((this._features.web || this._features.dns) && !man) {
        config.Env.push(`__MANAGEMENT_INTERFACE=eth${netid++}`);
      }
    }


    switch (this._networks.primary || 'none') {
      case 'none':
      {
        if (this._features.web || this._features.dns) {
          const management = await Network.getManagementNetwork();
          config.HostConfig.NetworkMode = management.id;
        }
        else {
          config.HostConfig.NetworkMode = 'none';
        }
        break;
      }
      case 'home':
      {
        // If we need the home network, we set that up as primary
        const homenet = await Network.getHomeNetwork();
        config.HostConfig.NetworkMode = homenet.id;
        break;
      }
      case 'vpn':
        console.error('vpn cannot be primary network');
        break;
      default:
        // Alternatively, if we're using a private network we set that as primary
        if (this._networks.primary.startsWith('vpn-')) {
          const vpn = await Network.getPrivateNetwork(this._networks.primary);
          config.HostConfig.NetworkMode = vpn.id;
          const info = await vpn.inspect();
          const gw = info.IPAM.Config[0].Gateway.replace(/.\d$/,'.2');
          config.HostConfig.ExtraHosts = [
            `SERVICES:${gw}`
          ];
          config.Env.push(`__GATEWAY=${gw}`);
          config.HostConfig.Dns = [ gw ];
          config.HostConfig.DnsSearch = [ 'local.' ];
          config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:1', 'attempts:1' ];
        }
        break;
    }

    if (this._features.vpn) {
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

    this._fullEnv = config.Env;
  
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
      Env: [].concat(config.Env)
    };

    if (this._networks.primary === 'home' || this._networks.secondary === 'home') {
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

      if ((this._networks.primary || 'none') != 'none') {
  
        switch (this._networks.secondary || 'none') {
          case 'none':
            break;
          case 'home':
          {
            const homenet = await Network.getHomeNetwork();
            await homenet.connect({
              Container: this._helperContainer.id
            });
            break;
          }
          case 'vpn':
          {
            const vpn = await Network.getPrivateNetwork(`vpn-${this._name}`);
            await vpn.connect({
              Container: this._helperContainer.id
            });
            break;
          }
          default:
            if (this._networks.secondary.startsWith('vpn-')) {
              const vpn = await Network.getPrivateNetwork(this._networks.secondary);
              await vpn.connect({
                Container: this._helperContainer.id
              });
            }
            break;
        }

        if ((this._features.web || this._features.dns) && helperConfig.HostConfig.NetworkMode !== 'management')  {
          const management = await Network.getManagementNetwork();
          await management.connect({
            Container: this._helperContainer.id
          });
        }

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
    if (this._features.web) {
      this._forward = HTTPForward.createForward({ prefix: `/a/${this._name}`, IP4Address: containerInfo.NetworkSettings.Networks.management.IPAddress, port: parseInt(TCP_HTTP) });
      koaApp.use(this._forward.http);
      koaApp.ws.use(this._forward.ws);
    }
    if (this._features.dns) {
      this._dns = DNSForward.createForward({ name: this._name, IP4Address: containerInfo.NetworkSettings.Networks.management.IPAddress });
    }

    if (this._features.vpn) {
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
      this._dns = null;
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
      this._forward = null;
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
    if (this._online) {
      await this.stop();
    }
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
    if (!app._networks.primary.startsWith('vpn-') && !app._networks.secondary.startsWith('vpn-')) {
      await app.start();
    }
  }));
  // Then start the apps which are connected to the private networks
  await Promise.all(applications.map(async (app) => {
    if (app._networks.primary.startsWith('vpn-') || app._networks.secondary.startsWith('vpn-')) {
      await app.start();
    }
  }));
}

MinkeApp.shutdown = async function() {
  await Promise.all(applications.map(async (app) => {
    if (app._online) {
      await app.stop();
      await app.save();
    }
  }));
}

MinkeApp.getApps = function() {
  return applications;
}

MinkeApp.getNetworks = function() {
  return MinkeApp.getApps().reduce((acc, app) => {
    if (app._networks.secondary === 'vpn') {
      acc.push({
        id: app._name,
        name: `vpn-${app._name}`
      });
    }
    return acc;
  }, [ { id: 'home', name: 'home' }]);
}

module.exports = MinkeApp;
