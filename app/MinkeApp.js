const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const Path = require('path');
const HTTPForward = require('./HTTPForward');
const DNSForward = require('./DNSForward');
const Network = require('./Network');
const Filesystem = require('./Filesystem');
const Database = require('./Database');
const Monitor = require('./Monitor');
const Images = require('./Images');
const Skeletons = require('./skeletons/Skeletons');

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

    this._setStatus('stopped');

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

  createFromSkeleton: function(skel) {
    const apps = MinkeApp.getApps();
    let name = null;
    for (let i = 1; ; i++) {
      name = `${skel.name} ${i}`;
      if (!apps.find(app => name === app._name)) {
        break;
      }
    }

    this._id = undefined;
    this._name = name;
    this._image = skel.image,
  
    this.updateFromSkeleton(skel, {});

    this._setStatus('stopped');

    return this;
  },

  updateFromSkeleton: function(skel, defs) {
    this._description = skel.description;
    this._args = '';
  
    this._env = skel.properties.reduce((r, prop) => {
      if (prop.type === 'Environment') {
        if (defs.env) {
          const key = `${prop.name}=`;
          const found = defs.env.find(env => env.indexOf(key) === 0);
          if (found) {
            r.push(found);
          }
          else {
            r.push(`${prop.name}=${prop.defaultValue || ''}`);
          }
        }
        else {
          r.push(`${prop.name}=${prop.defaultValue || ''}`);
        }
      }
      return r;
    }, []);
    this._features = skel.properties.reduce((r, prop) => {
      if (prop.type === 'Feature') {
        if (defs.features && prop.name in defs.features) {
          r[prop.name] = defs.features[prop.name];
        }
        else {
          r[prop.name] = 'defaultValue' in prop ? prop.defaultValue : true;
        }
      }
      return r;
    }, {});
    this._networks = skel.properties.reduce((r, prop) => {
      if (prop.type === 'Network') {
        if (defs.networks && prop.name in defs.networks) {
          r[prop.name] = defs.networks[prop.name];
        }
        else {
          r[prop.name] = (prop.defaultValue === '__self' ? this._name : prop.defaultValue) || 'none';
        }
      }
      return r;
    }, {});
    this._ports = skel.properties.reduce((r, prop) => {
      if (prop.type === 'Port') {
        const port = defs.ports && defs.ports.find(port => port.target === prop.name);
        if (port) {
          r.push(port);
        }
        else {
          r.push({
            target: prop.name,
            host: parseInt(prop.name),
            protocol: prop.name.split('/')[1].toUpperCase(),
            web: prop.web,
            dns: prop.dns,
            nat: prop.nat,
            mdns: prop.mdns
          });
        }
      }
      return r;
    }, []);
    this._binds = skel.properties.reduce((r, prop) => {
      if (prop.type === 'Directory') {
        const target = Path.normalize(prop.name);
        const bind = defs.binds && defs.binds.find(bind => bind.target === target);
        if (bind) {
          r.push(bind);
        }
        else {
          r.push({
            host: Path.normalize(`/dir/${prop.name}`),
            target: target,
            shareable: false,
            shared: false,
            description: ''
          });
        }
      }
      return r;
    }, []);
    this._files = skel.properties.reduce((r, prop) => {
      if (prop.type === 'File') {
        const target = Path.normalize(prop.name);
        const file = defs.files && defs.files.find(file => file.target === target);
        if (file) {
          r.push(file);
        }
        else {
          const f = {
            host: Path.normalize(`/file/${prop.name.replace(/\//g, '_')}`),
            target: target,
            data: prop.defaultValue || ''
          };
          if ('defaultAltValue' in prop) {
            f.altData = prop.defaultAltValue;
          }
          r.push(f);
        }
      }
      return r;
    }, []);
    this._monitor = skel.monitor;

    return this;
  },

  start: async function() {

    this._setStatus('starting');

    // Build the helper
    this._fs = Filesystem.create(this);
  
    const config = {
      name: `${this._safeName()}__${this._id}`,
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
    let primary = this._networks.primary || 'none';
    let secondary = this._networks.secondary || 'none';
    if (primary === 'none') {
      primary = secondary;
      secondary = 'none';
    }
    if (primary === 'host' && !MinkeApp._container) {
      primary = 'home';
    }
    if (primary === secondary) {
      secondary = 'none';
    }

    switch (primary) {
      case 'none':
        break;
      case 'home':
        config.Env.push(`__HOME_INTERFACE=eth${netid++}`);
        break;
      case 'host':
        config.Env.push(`__HOST_INTERFACE=eth${netid++}`);
        break;
      default:
        if (primary === this._name) {
          console.error('Cannot create a VPN as primary network');
        }
        else {
          config.Env.push(`__PRIVATE_INTERFACE=eth${netid++}`);
        }
        break;
    }
    switch (secondary) {
      case 'none':
        break;
      case 'home':
        config.Env.push(`__HOME_INTERFACE=eth${netid++}`);
        break;
      default:
        config.Env.push(`__PRIVATE_INTERFACE=eth${netid++}`);
        break;
    }
    // Need management network if we're not connected to the home network in some way
    let management = null;
    if (!((primary === 'home' || primary === 'host') || secondary === 'home')) {
      config.Env.push(`__MANAGEMENT_INTERFACE=eth${netid++}`);
      management = await Network.getManagementNetwork();
    }

    switch (primary) {
      case 'none':
        if (management) {
          config.HostConfig.NetworkMode = management.id;
          management = null;
        }
        else {
          config.HostConfig.NetworkMode = 'none';
        }
        break;
      case 'home':
      {
        const homenet = await Network.getHomeNetwork();
        config.HostConfig.NetworkMode = homenet.id;
        config.Env.push(`__DNSSERVER=${MinkeApp._network.network.ip_address}`);
        config.Env.push(`__GATEWAY=${MinkeApp._network.network.gateway_ip}`);
        config.Env.push(`__HOSTIP=${MinkeApp._network.network.ip_address}`);
        config.HostConfig.Dns = [ MinkeApp._network.network.ip_address ];
        config.HostConfig.DnsSearch = [ 'local.' ];
        config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:1', 'attempts:1' ];
        break;
      }
      case 'host':
      {
        config.HostConfig.NetworkMode = `container:${MinkeApp._container.id}`;
        config.Hostname = null;
        this._homeIP = MinkeApp._network.network.ip_address;
        config.Env.push(`__DNSSERVER=${this._homeIP}`);
        config.Env.push(`__GATEWAY=${MinkeApp._network.network.gateway_ip}`);
        config.Env.push(`__HOSTIP=${this._homeIP}`);
        break;
      }
      default:
      {
        // If we're using a private network as primary, then we also select the X.X.X.2
        // address as both the default gateway and the dns server. The server at X.X.X.2
        // should be the creator (e.g. VPN client/server) for this network.
        const vpn = await Network.getPrivateNetwork(primary);
        config.HostConfig.NetworkMode = vpn.id;
        const dns = vpn.info.IPAM.Config[0].Gateway.replace(/.\d$/,'.2');
        config.Env.push(`__DNSSERVER=${dns}`);
        config.Env.push(`__GATEWAY=${dns}`);
        config.HostConfig.Dns = [ dns ];
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
    if (this._features.dhcp) {
      config.HostConfig.CapAdd.push('NET_ADMIN');
    }

    this._fullEnv = config.Env;

    if (primary !== 'host') {
  
      const helperConfig = {
        name: `helper-${this._safeName()}__${this._id}`,
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

      if (primary === 'home' || secondary === 'home') {
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

      this._helperContainer = await docker.createContainer(helperConfig);

      config.Hostname = null;
      config.HostConfig.ExtraHosts = null;
      config.HostConfig.Dns = null;
      config.HostConfig.DnsSearch = null;
      config.HostConfig.DnsOptions = null;
      config.HostConfig.NetworkMode = `container:${this._helperContainer.id}`;

      await this._helperContainer.start();

      if (primary != 'none') {
        switch (secondary) {
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
            const vpn = await Network.getPrivateNetwork(secondary);
            await vpn.connect({
              Container: this._helperContainer.id
            });
            break;
          }
        }
      }

      if (management) {
        await management.connect({
          Container: this._helperContainer.id
        });
        management = null;
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

    let ipAddr = this._homeIP;
    if (!ipAddr && this._helperContainer) {
      const containerInfo = await this._helperContainer.inspect();
      ipAddr = containerInfo.NetworkSettings.Networks.management.IPAddress;
    }

    if (ipAddr) {

      const webport = this._ports.find(port => port.web);
      if (webport) {
        if (this._homeIP) {
          if (webport.web === 'newtab') {
            this._forward = HTTPForward.createNewTab({ prefix: `/a/${this._id}`, url: `http${webport.host === 443 ? 's' : ''}://${ipAddr}:${webport.host}` });
          }
          else {
            this._forward = HTTPForward.createRedirect({ prefix: `/a/${this._id}`, url: `http${webport.host === 443 ? 's' : ''}://${ipAddr}:${webport.host}` });
          }
        }
        else {
          this._forward = HTTPForward.createForward({ prefix: `/a/${this._id}`, IP4Address: ipAddr, port: webport.host });
        }
        if (this._forward.http) {
          koaApp.use(this._forward.http);
        }
        if (this._forward.ws) {
          koaApp.ws.use(this._forward.ws);
        }
      }

      const dnsport = this._ports.find(port => port.dns);
      if (dnsport) {
        this._dns = DNSForward.createForward({ _id: this._id, name: this._name, IP4Address: ipAddr, port: dnsport.host });
      }

    }

    if (this._image === Images.MINKE_PRIVATE_NETWORK) {
      this._monitorNetwork();
      this._remoteServices = [];
      this.on('update.network.status', this._updateNetworkStatus);
    }

    if (this._monitor.cmd) {
      this._statusMonitor = this._createMonitor({
        event: 'update.monitor',
        polling: this._monitor.polling,
        cmd: this._monitor.cmd,
        watch: this._monitor.watch,
        parser: this._monitor.parser,
        template: this._monitor.template
      });
    }

    this._setStatus('running');

    return this;
  },

  stop: async function() {

    this._setStatus('stopping');
  
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
    this._homeIP = null;

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
      await Promise.all(stopping.map(stop => stop.catch(e => console.log(e)))); // Ignore exceptions
    }
    catch (_) {
    }

    // Wait for things to stop before unmounting
    if (this._fs) {
      this._fs.unshareVolumes();
      this._fs = null;
    }

    this._setStatus('stopped');

    return this;
  },

  restart: async function(save) {
    if (this._status === 'running') {
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
    if (this._status === 'running') {
      await this.stop();
    }
    if (fs) {
      fs.uninstall();
    }
    await Database.removeApp(this._id);

    MinkeApp.emit('app.remove', { app: this });
    if (this._features.vpn === 'network') {
      MinkeApp.emit('net.remove', { network: { _id: this._name.replace(/ /g, '-'), name: this._name } });
    }
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
        const localapp = applications.find(app => app._safeName() === target);
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

  _setStatus: function(status) {
    if (this._status === status) {
      return;
    }
    //DEBUG && console.log(`${this._name}/${this._id}: ${this._status} -> ${status}`);
    this._status = status;
    this._emit('update.status', { status: status });
  },

  _safeName: function() {
    return this._name.replace(/[^a-zA-Z0-9]/g, '');
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

MinkeApp.adminMode = true;

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
                  const app = applications.find(app => (app._container && app._container.id === id) || 
                    (app._helperContainer && app._helperContainer.id === id));
                  if (app && app._status === 'running') {
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
      MinkeApp._container = docker.getContainer(container.Id);
      container.Mounts.forEach((mount) => {
        if (mount.Type === 'bind' && mount.Destination === '/minke/fs') {
          Filesystem.setHostPrefix(mount.Source);
        }
      })
    }
  });

  // Get our IP
  MinkeApp._network = await Network.getActiveInterface();

  if (MinkeApp._container) {
    const homenet = await Network.getManagementNetwork();
    await homenet.connect({
      Container: MinkeApp._container.id
    });
  }

  // Monitor docker events
  MinkeApp._monitorEvents();

  const running = await docker.listContainers({ all: true });
  const runningNames = running.map(container => container.Names[0]);

  // Load all the apps
  applications = (await Database.getApps()).map((json) => {
    return new MinkeApp().createFromJSON(json);
  });

  // Stop apps if they're still running
  await Promise.all(applications.map(async (app) => {
    let idx = runningNames.indexOf(`/${app._safeName()}__${app._id}`);
    if (idx !== -1) {
      await docker.getContainer(running[idx].Id).remove({ force: true });
    }
    idx = runningNames.indexOf(`/helper-${app._safeName()}__${app._id}`);
    if (idx !== -1) {
      await docker.getContainer(running[idx].Id).remove({ force: true });
    }
  }));

  // Hardwired default resolver
  DNSForward.setDefaultResolver('1.1.1.1');

  // Start up any DHCP servers.
  await Promise.all(applications.map(async (app) => {
    try {
      if (app._features.dhcp) {
        await app.start();
      }
    }
    catch (e) {
      console.error(e);
    }
  }));
  // Start up any VPNs. We want them to claim the lowest IP on their networks.
  await Promise.all(applications.map(async (app) => {
    try {
      if (app._features.vpn === 'network') {
        await app.start();
      }
    }
    catch (e) {
      console.error(e);
    }
  }));
  // Then the rest
  await Promise.all(applications.map(async (app) => {
    try {
      if (app._status === 'stopped') {
        await app.start();
      }
    }
    catch (e) {
      console.error(e);
    }
  }));
}

MinkeApp.shutdown = async function() {
  await Promise.all(applications.map(async (app) => {
    if (app._status === 'running') {
      await app.stop();
      await app.save();
    }
  }));
}

MinkeApp.create = async function(image) {
  const app = new MinkeApp().createFromSkeleton(await Skeletons.loadSkeleton(image, true));
  app._id = Database.newAppId();
  applications.push(app);
  await app.save();
  MinkeApp.emit('app.create', { app: app });
  if (app._features.vpn === 'network') {
    MinkeApp.emit('net.create', { network: { _id: app._name.replace(/ /g, '-'), name: app._name }});
  }
  return app;
}

MinkeApp.getApps = function() {
  return applications;
}

MinkeApp.getNetworks = function() {
  return MinkeApp.getApps().reduce((acc, app) => {
    if (app._features.vpn === 'network') {
      acc.push({
        _id: app._name.replace(/ /g, '-'),
        name: app._name
      });
    }
    return acc;
  }, [ { name: 'home' }]);
}

module.exports = MinkeApp;
