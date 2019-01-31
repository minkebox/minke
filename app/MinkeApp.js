const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const HTTPForward = require('./HTTPForward');
const DNSForward = require('./DNSForward');
const Network = require('./Network');
const Filesystem = require('./Filesystem');
const Database = require('./Database');
const Monitor = require('./Monitor');
const Images = require('./Images');

let applications = null;
let koaApp = null;

function MinkeApp() {
  EventEmitter.call(this);
  this._setupUpdateListeners();
}

MinkeApp.prototype = {

  createFromJSON: function(app) {

    this._id = app._id;
    this._name = app.name;
    this._description = app.description;
    this._image = app.image;
    this._args = app.args;
    this._env = app.env;
    this._features = app.features || {},
    this._ports = app.ports;
    this._binds = app.binds;
    this._files = app.files;
    this._networks = app.networks;
    this._monitor = app.monitor;

    this._setOnline(false);

    return this;
  },

  toJSON: function() {
    return {
      _id: this._id,
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
      name: this._safeName(),
      Hostname: this._safeName(),
      Image: this._image,
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

    // Create network environment
    let netid = 0;
    let man = false;
    let helper = false;
    switch (this._networks.primary || 'none') {
      case 'none':
        if (this._features.web || this._features.dns) {
          config.Env.push(`__MANAGEMENT_INTERFACE=eth${netid++}`);
          man = true;
        }
        break;
      case 'home':
        config.Env.push(`__HOME_INTERFACE=eth${netid++}`);
        helper = true;
        break;
      default:
        if (this._networks.primary === this._name) {
          console.error('Cannot create a VPN as primary network');
        }
        else {
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
          helper = true;
          break;
        default:
          config.Env.push(`__PRIVATE_INTERFACE=eth${netid++}`);
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
        const homenet = await Network.getHomeNetwork();
        config.HostConfig.NetworkMode = homenet.id;
        break;
      }
      default:
      {
        // If we're using a private network as primary, then we also select the X.X.X.2
        // address as both the default gateway and the dns server. The server at X.X.X.2
        // should be the creator (e.g. VPN client/server) for this network.
        const vpn = await Network.getPrivateNetwork(this._networks.primary);
        config.HostConfig.NetworkMode = vpn.id;
        const info = await vpn.inspect();
        const gw = info.IPAM.Config[0].Gateway.replace(/.\d$/,'.2');
        config.HostConfig.ExtraHosts = [
          `SERVICES:${gw}`
        ];
        config.Env.push(`__GATEWAY=${gw}`);
        config.Env.push(`__DNSSERVER=${gw}`);
        config.HostConfig.Dns = [ gw ];
        config.HostConfig.DnsSearch = [ 'local.' ];
        config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:1', 'attempts:1' ];
        break;
      }
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
      name: `helper-${this._safeName()}`,
      Hostname: config.Hostname,
      Image: Images.MINKE_HELPER,
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
      helper = true;
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
        helper = true;
      }
      if (mdns.length) {
        helperConfig.Env.push(`ENABLE_MDNS=${mdns.join(' ')}`);
        helper = true;
      }
    }
  
    if (helper) {
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
          default:
          {
            const vpn = await Network.getPrivateNetwork(this._networks.secondary);
            await vpn.connect({
              Container: this._helperContainer.id
            });
            break;
          }
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
            data = data.toString('utf8');
            const idx = data.indexOf('MINKE:HOME:IP ');
            if (idx !== -1) {
              this._homeIP = data.replace(/.*MINKE:HOME:IP (.*)\n.*/, '$1');
            }
            if (data.indexOf('MINKE:UP') !== -1) {
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
      if (this._homeIP) {
        this._forward = HTTPForward.createRedirect({ prefix: `/a/${this._id}`, url: `http://${this._homeIP}` });
      }
      else {
        this._forward = HTTPForward.createForward({ prefix: `/a/${this._id}`, IP4Address: containerInfo.NetworkSettings.Networks.management.IPAddress, port: 80 });
      }
      if (this._forward.http) {
        koaApp.use(this._forward.http);
      }
      if (this._forward.ws) {
        koaApp.ws.use(this._forward.ws);
      }
    }
    if (this._features.dns) {
      this._dns = DNSForward.createForward({ _id: this._id, name: this._name, IP4Address: containerInfo.NetworkSettings.Networks.management.IPAddress });
    }

    if (this._features.vpn) {
      this._monitorNetwork();
      this._remoteServices = [];
      this.on('update.network.status', this._updateNetworkStatus);
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
      this.off('update.network.status', this._updateNetworkStatus);
      this._remoteServices = null;
    }
    catch (_) {
    }

    if (this._fs) {
      this._fs.unshareVolumes();
      this._fs = null;
    }

    if (this._dns) {
      DNSForward.removeForward(this._dns);
      this._dns = null;
    }

    if (this._forward) {
      if (this._forward.http) {
        const idx = koaApp.middleware.indexOf(this._forward.http);
        if (idx !== -1) {
          koaApp.middleware.splice(idx, 1);
        }
      }
      if (this._forward.ws) {
        const widx = koaApp.ws.middleware.indexOf(this._forward.ws);
        if (widx !== -1) {
          koaApp.ws.middleware.splice(widx, 1);
        }
      }
      this._forward = null;
    }

    const stopping = [];
    if (this._helperContainer) {
      stopping.push(this._helperContainer.stop());
      this._helperContainer = null;
    }
    if (this._container) {
      stopping.push(this._container.stop());
      this._container = null;
    }
    try {
      await Promise.all(stopping.map(stop => stop.catch(e => e))); // Ignore exceptions
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
    await Database.saveApp(this.toJSON());
    return this;
  },

  uninstall: async function() {
    const idx = applications.indexOf(this);
    if (idx !== -1) {
      applications.splice(idx, 1);
    }
    const fs = this._fs; // This will be nulled when we stop.
    if (this._online) {
      await this.stop();
    }
    if (fs) {
      fs.uninstall();
    }
    await Database.removeApp(this._id);

    MinkeApp.emit('app.remove', { app: this });
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

  _updateNetworkStatus: function(status) {
    const remotes = [];
    const services = status.data;
    for (let name in services) {
      services[name].forEach((service) => {
        const target = service.target.replace(/(.*).local/, '$1');
        const localapp = applications.find(app => app._name === target);
        if (localapp && (localapp._networks.primary === this._name || localapp._networks.secondary === this._name)) {
          // Ignore local apps connected to this network
        }
        else {
          remotes.push({
            name: name,
            target: target,
            port: service.port,
            address: service.a,
            txt: (service.txt || '').split('\n').reduce((acc, rec) => {
              const kv = rec.split('=');
              if (kv.length === 2) {
                acc[kv[0]] = kv[1];
              }
              return acc;
            }, {})
          });
        }
      });
    }
    this._remoteServices = remotes;
    this._emit('update.services', { services: this._remoteServices });
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

  _safeName: function() {
    return this._name.replace(/ /g, '_');
  },

  _setupUpdateListeners: function() {

    this._updateNetworkStatus = this._updateNetworkStatus.bind(this);
  
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

Object.assign(MinkeApp, {
  _events: new EventEmitter(),
  on: (evt, listener) => { return MinkeApp._events.on(evt, listener); },
  off: (evt, listener) => { return MinkeApp._events.off(evt, listener); },
  emit: (evt, data) => { return MinkeApp._events.emit(evt, data); },
});

MinkeApp._monitorEvents = async function() {
  const stream = await docker.getEvents({});
  await new Promise(() => {
    stream.on('readable', () => {
      const lines = stream.read().toString('utf8').split('\n');
      lines.forEach((line) => {
        if (!line) {
          return;
        }
        try {
          const event = JSON.parse(line);
          switch (event.Type) {
            case 'container':
              switch (event.Action) {
                case 'create':
                case 'start':
                case 'stop':
                case 'destroy':
                  break;
                case 'die':
                {
                  const id = event.id;
                  const app = applications.find(app => app._container && app._container.id == id);
                  if (app) {
                    app.stop();
                  }
                  break;
                }
                default:
                  break;
              }
              break;
            case 'network':
              break;
            case 'volume':
              break;
            case 'image':
              break;
            default:
              break;
          }
        }
        catch (_) {
        }
      });
    });
  });
}

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

  // Monitor docker events
  MinkeApp._monitorEvents();

  const running = await docker.listContainers();
  const runningNames = running.map(container => container.Names[0]);

  // Load all the apps
  applications = (await Database.getApps()).map((json) => {
    return new MinkeApp().createFromJSON(json);
  });

  // Stop apps if they're still running
  await Promise.all(applications.map(async (app) => {
    let idx = runningNames.indexOf(`/${app._safeName()}`);
    if (idx !== -1) {
      await (await docker.getContainer(running[idx].Id)).stop();
    }
    idx = runningNames.indexOf(`/helper-${app._safeName()}`);
    if (idx !== -1) {
      await (await docker.getContainer(running[idx].Id)).stop();
    }
  }));

  // Hardwired default resolver
  DNSForward.setDefaultResolver('1.1.1.1');

  // Start up any VPN first. We want them to claim the lowest IP on their networks.
  await Promise.all(applications.map(async (app) => {
    if (app._features.vpn) {
      await app.start();
    }
  }));
  // Then the rest
  await Promise.all(applications.map(async (app) => {
    if (!app._features.vpn) {
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

MinkeApp.create = async function(json) {
  const app = new MinkeApp().createFromJSON(json);
  app._id = Database.newAppId();
  applications.push(app);
  MinkeApp.emit('app.create', { app: app });
  return app;
}

MinkeApp.getApps = function() {
  return applications;
}

MinkeApp.getNetworks = function() {
  return MinkeApp.getApps().reduce((acc, app) => {
    if (app._features.vpn) {
      acc.push({
        name: app._name
      });
    }
    return acc;
  }, [ { name: 'home' }]);
}

module.exports = MinkeApp;
