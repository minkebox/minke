const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const Path = require('path');
const Moment = require('moment-timezone');
const UUID = require('uuid/v4');
const HTTP = require('./HTTP');
const DNS = require('./DNS');
const DDNS = require('./DDNS');
const MDNS = require('./MDNS');
const Network = require('./Network');
const Filesystem = require('./Filesystem');
const Database = require('./Database');
const Monitor = require('./Monitor');
const Images = require('./Images');
const Skeletons = require('./skeletons/Skeletons');

const GLOBALDOMAIN = '.minkebox.net';

const CRASH_TIMEOUT = (2 * 60 * 1000); // 2 minutes

let applications = [];
let koaApp = null;
let networkApps = [];
let setup = null;

function MinkeApp() {
  EventEmitter.call(this);
  this._setupUpdateListeners();
}

MinkeApp.prototype = {

  createFromJSON: function(app) {

    this._id = app._id;
    this._globalId = app.globalId;
    this._name = app.name;
    this._description = app.description;
    this._image = app.image;
    this._args = app.args;
    this._env = app.env;
    this._features = app.features,
    this._ports = app.ports;
    this._binds = app.binds;
    this._files = app.files;
    this._shares = app.shares;
    this._customshares = app.customshares;
    this._networks = app.networks;
    this._bootcount = app.bootcount;
    this._secondary = app.secondary || [];

    // FIX
    if (!Array.isArray(this._args)) {
      this._args = undefined;
    }
    // FIX

    const skel = Skeletons.loadSkeleton(this._image, false);
    if (skel && skel.monitor) {
      this._monitor = skel.monitor;
      this._delay = skel.delay || 0;
      this._tags = (skel.tags || []).concat([ 'All' ]);
    }
    else {
      this._monitor = {};
      this._delay = 0;
      this._tags = [ 'All' ];
    }

    this._setStatus('stopped');

    return this;
  },

  toJSON: function() {
    return {
      _id: this._id,
      globalId: this._globalId,
      name: this._name,
      description: this._description,
      image: this._image,
      args: this._args,
      env: this._env,
      features: this._features,
      ports: this._ports,
      binds: this._binds,
      files: this._files,
      shares: this._shares,
      customshares: this._customshares,
      networks: this._networks,
      bootcount: this._bootcount,
      secondary: this._secondary
    }
  },

  createFromSkeleton: function(skel) {
    let name = null;
    for (let i = 1; ; i++) {
      name = `${skel.name} ${i}`;
      if (!applications.find(app => name === app._name)) {
        break;
      }
    }

    this._id = Database.newAppId();
    this._name = name;
    this._image = skel.image,
    this._globalId = UUID();

    this.updateFromSkeleton(skel, {});

    this._setStatus('stopped');

    return this;
  },

  updateFromSkeleton: function(skel, defs) {

    this._description = skel.description;
    this._args = (skel.properties.find(prop => prop.type === 'Arguments') || {}).defaultValue;
    this._networks = skel.properties.reduce((r, prop) => {
      if (prop.type === 'Network') {
        if (defs.networks && prop.name in defs.networks) {
          r[prop.name] = defs.networks[prop.name];
        }
        else {
          r[prop.name] = (prop.defaultValue === '__create' ? this._id : prop.defaultValue) || 'none';
        }
      }
      return r;
    }, {});
    this._parseProperties(this, '', skel.properties, defs);
    if (skel.secondary) {
      this._secondary = skel.secondary.map((secondary, idx) => {
        const secondaryApp = {
          _image: secondary.image,
          _args: (secondary.properties.find(prop => prop.type === 'Arguments') || {}).defaultValue,
          _delay: secondary.delay || 0
        };
        this._parseProperties(secondaryApp, `${idx}`, secondary.properties, {});
        return secondaryApp;
      });
    }
    else {
      this._secondary = [];
    }
    this._delay = skel.delay || 5;
    this._monitor = skel.monitor || {};
    this._bootcount = 0;
    this._tags = (skel.tags || []).concat([ 'All' ]);

    return this;
  },

  _parseProperties: function(target, ext, properties, defs) {
    target._env = {};
    target._features = {};
    target._ports = [];
    target._binds = [];
    target._files = [];
    target._shares = [];
    target._customshares = [];
    properties.forEach(prop => {
      switch (prop.type) {
        case 'Environment':
        {
          const found = (defs.env || {})[prop.name];
          if (found) {
            target._env[prop.name] = found;
          }
          else {
            target._env[prop.name] = { value: 'defaultValue' in prop ? prop.defaultValue : '' };
            if ('defaultAltValue' in prop) {
              target._env[prop.name].altValue = prop.defaultAltValue;
            }
          }
          break;
        }
        case 'Feature':
        {
          if (defs.features && prop.name in defs.features) {
            target._features[prop.name] = defs.features[prop.name];
          }
          else {
            target._features[prop.name] = 'defaultValue' in prop ? prop.defaultValue : true;
          }
          break;
        }
        case 'Port':
        {
          const port = defs.ports && defs.ports.find(port => port.target === prop.name);
          if (port) {
            target._ports.push(port);
          }
          else {
            target._ports.push({
              target: prop.name,
              port: prop.port,
              protocol: prop.protocol,
              web: prop.web,
              dns: prop.dns,
              nat: prop.nat,
              mdns: prop.mdns
            });
          }
          break;
        }
        case 'Directory':
        {
          const targetname = Path.normalize(prop.name);
          const bind = defs.binds && defs.binds.find(bind => bind.target === targetname);
          if (bind) {
            target._binds.push(bind);
          }
          else {
            target._binds.push({
              src: Filesystem.getNativePath(this._id, prop.style, `/dir${ext}/${targetname}`),
              target: targetname,
              shares: prop.shares || [],
              description: prop.description || targetname
            });
          }
          break;
        }
        case 'File':
        {
          const targetname = Path.normalize(prop.name);
          const file = defs.files && defs.files.find(file => file.target === targetname);
          if (file) {
            target._files.push(file);
          }
          else {
            const f = {
              src: Filesystem.getNativePath(this._id, prop.style, `/file${ext}/${prop.name.replace(/\//g, '_')}`),
              target: targetname,
              mode: prop.mode || 0o666,
              data: prop.defaultValue || ''
            };
            if ('defaultAltValue' in prop) {
              f.altData = prop.defaultAltValue;
            }
            target._files.push(f);
          }
          break;
        }
        default:
          break;
      }
    });
  },

  start: async function(inherit) {

    try {
      this._setStatus('starting');

      this._bootcount++;
      this._needRestart = false;

      inherit = inherit || {};

      this._fs = Filesystem.create(this);

      const config = {
        name: `${this._safeName()}__${this._id}`,
        Hostname: this._safeName(),
        Image: Images.withTag(this._image),
        Cmd: this._args,
        HostConfig: {
          Mounts: this._fs.getAllMounts(this),
          Devices: [],
          CapAdd: [],
          LogConfig: {
            Type: 'json-file',
            Config: {
              'max-file': '1',
              'max-size': '10k'
            }
          }
        }
      };

      const configEnv = [];

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
          configEnv.push(`__HOME_INTERFACE=eth${netid++}`);
          break;
        case 'host':
          configEnv.push(`__HOST_INTERFACE=eth${netid++}`);
          break;
        default:
          if (primary === this._id) {
            console.error('Cannot create a VPN as primary network');
          }
          else {
            configEnv.push(`__PRIVATE_INTERFACE=eth${netid++}`);
          }
          break;
      }
      switch (secondary) {
        case 'none':
          break;
        case 'home':
          configEnv.push(`__HOME_INTERFACE=eth${netid++}`);
          break;
        default:
          configEnv.push(`__PRIVATE_INTERFACE=eth${netid++}`);
          break;
      }
      // Need management network if we're not connected to the home network in some way
      let management = null;
      if (!((primary === 'home' || primary === 'host') || secondary === 'home')) {
        configEnv.push(`__MANAGEMENT_INTERFACE=eth${netid++}`);
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
          config.MacAddress = this._primaryMacAddress();
          configEnv.push(`__DNSSERVER=${MinkeApp._network.network.ip_address}`);
          configEnv.push(`__GATEWAY=${MinkeApp._network.network.gateway_ip}`);
          configEnv.push(`__HOSTIP=${MinkeApp._network.network.ip_address}`);
          configEnv.push(`__DOMAINNAME=${MinkeApp.getLocalDomainName()}`);
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
          configEnv.push(`__DNSSERVER=${this._homeIP}`);
          configEnv.push(`__GATEWAY=${MinkeApp._network.network.gateway_ip}`);
          configEnv.push(`__HOSTIP=${this._homeIP}`);
          configEnv.push(`__DOMAINNAME=${MinkeApp.getLocalDomainName()}`);
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
          configEnv.push(`__DNSSERVER=${dns}`);
          configEnv.push(`__GATEWAY=${dns}`);
          config.HostConfig.Dns = [ dns ];
          config.HostConfig.DnsSearch = [ 'local.' ];
          config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:1', 'attempts:1' ];
          // When we start a new app which is attached to a private network, we must restart the
          // private network so it can inform the peer about the new app.
          const napp = MinkeApp.getAppById(primary);
          if (napp && napp._image === Images.withTag(Images.MINKE_PRIVATE_NETWORK)) {
            napp._needRestart = true;
          }
          break;
        }
      }

      configEnv.push(`__GLOBALID=${this._globalId}`);

      if (this._features.vpn) {
        config.HostConfig.Devices.push({
          PathOnHost: '/dev/net/tun',
          PathInContainer: '/dev/net/tun',
          CgroupPermissions: 'rwm'
        });
        config.HostConfig.Sysctls = {
          "net.ipv4.ip_forward": "1"
        };
      }
      if (this._features.vpn || this._features.dhcp) {
        config.HostConfig.CapAdd.push('NET_ADMIN');
      }
      if (this._features.mount) {
        config.HostConfig.CapAdd.push('SYS_ADMIN');
        config.HostConfig.CapAdd.push('DAC_READ_SEARCH');
      }
      if (this._features.privileged) {
        config.HostConfig.Privileged = true;
      }

      if (this._features.vpn) {
        let nr = 0;
        applications.forEach((app) => {
          if (app._networks.primary === this._id && app._privateIP) {
            app._ports.forEach((port) => {
              if (port.vpn) {
                configEnv.push(`PORT_${nr}=${app._privateIP}:${port.port}:${port.protocol}:${port.mdns ? Buffer.from(JSON.stringify(port.mdns), 'utf8').toString('base64') : ''}`);
                nr++;
              }
            });
          }
        });
        configEnv.push(`PORTMAX=${nr-1}`);
      }

      if (primary !== 'host') {

        const helperConfig = {
          name: `helper-${this._safeName()}__${this._id}`,
          Hostname: config.Hostname,
          Image: Images.withTag(Images.MINKE_HELPER),
          HostConfig: {
            NetworkMode: config.HostConfig.NetworkMode,
            CapAdd: [ 'NET_ADMIN' ],
            ExtraHosts: config.HostConfig.ExtraHosts,
            Dns: config.HostConfig.Dns,
            DnsSearch: config.HostConfig.DnsSearch,
            DnsOptions: config.HostConfig.DnsOptions
          },
          MacAddress: config.MacAddress,
          Env: Object.keys(this._env).map(key => `${key}=${this.expand(this._env[key].value)}`).concat(configEnv)
        };

        if (primary === 'home' || secondary === 'home') {
          helperConfig.Env.push('ENABLE_DHCP=1');
        }

        this._ddns = false;
        if (this._ports.length) {
          const nat = this._ports.reduce((acc, port) => {
            if (port.nat) {
              acc.push(`${port.port}:${port.protocol}`);
            }
            return acc;
          }, []);
          if (nat.length) {
            helperConfig.Env.push(`ENABLE_NAT=${nat.join(' ')}`);
            this._ddns = true;
          }
        }

        if (inherit.helperContainer) {
          this._helperContainer = inherit.helperContainer;
        }
        else {
          this._helperContainer = await docker.createContainer(helperConfig);
        }

        config.Hostname = null;
        config.HostConfig.ExtraHosts = null;
        config.HostConfig.Dns = null;
        config.HostConfig.DnsSearch = null;
        config.HostConfig.DnsOptions = null;
        config.HostConfig.NetworkMode = `container:${this._helperContainer.id}`;
        config.MacAddress = null;

        if (inherit.helperContainer !== this._helperContainer) {
          await this._helperContainer.start();
        }

        if (primary != 'none') {
          switch (secondary) {
            case 'none':
              break;
            case 'home':
            {
              try {
                const homenet = await Network.getHomeNetwork();
                await homenet.connect({
                  Container: this._helperContainer.id
                });
              }
              catch (e) {
                // Sometimes we get an error setting up the gateway, but we don't want it to set the gateway anyway so it's safe
                // to ignore.
                //console.error(e);
              }
              break;
            }
            default:
            {
              const vpn = await Network.getPrivateNetwork(secondary);
              try {
                await vpn.connect({
                  Container: this._helperContainer.id
                });
              }
              catch (e) {
                // Sometimes we get an error setting up the gateway, but we don't want it to set the gateway anyway so it's safe
                // to ignore.
                //console.error(e);
              }
              break;
            }
          }
        }

        if (management) {
          try {
            await management.connect({
              Container: this._helperContainer.id
            });
          }
          catch (e) {
            console.error(e);
            management = null;
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
              let idx = data.indexOf('MINKE:HOME:IP ');
              if (idx !== -1) {
                this._homeIP = data.replace(/.*MINKE:HOME:IP (.*)\n.*/, '$1');
              }
              idx = data.indexOf('MINKE:PRIVATE:IP ');
              if (idx !== -1) {
                this._privateIP = data.replace(/.*MINKE:PRIVATE:IP (.*)\n.*/, '$1');
              }
              if (data.indexOf('MINKE:UP') !== -1) {
                log.destroy();
                resolve();
              }
            }
          }, null);
        });

        if (this._homeIP) {
          DNS.registerHostIP(this._safeName(), this._homeIP);
          DNS.registerHostIP(`${this._globalId}${GLOBALDOMAIN}`, this._homeIP);
           // If we need to be accessed remotely, register with DDNS
          if (this._features.ddns || this._ddns || this._ports.find(port => port.nat)) {
            DDNS.register(this);
          }
        }

      }

      /*let ipAddr = this._homeIP;
      if (!ipAddr && this._helperContainer) {
        const containerInfo = await this._helperContainer.inspect();
        if (containerInfo.NetworkSettings.Networks.management) {
          ipAddr = containerInfo.NetworkSettings.Networks.management.IPAddress;
        }
        else {
          console.error('Missing management network', containerInfo.NetworkSettings.Networks);
        }
      }*/

      const ipAddr = this._homeIP || this._privateIP;
      if (ipAddr) {

        const webport = this._ports.find(port => port.web);
        if (webport) {
          let web = webport.web;
          if (typeof web !== 'object') {
            if (typeof web === 'string') {
              web = { type: web, path: '' };
            }
            else if (web === true) {
              web = { type: 'redirect', path: '' };
            }
            else {
              web = { type: 'none', path: '' };
            }
          }
          if (this._homeIP) {
            switch (web.type) {
              case 'newtab':
                this._forward = HTTP.createNewTab({ prefix: `/a/${this._id}`, url: `http${webport.port === 443 ? 's' : ''}://${ipAddr}:${webport.port}${web.path}` });
                break;
              case 'redirect':
                this._forward = HTTP.createRedirect({ prefix: `/a/${this._id}`, url: `http${webport.port === 443 ? 's' : ''}://${ipAddr}:${webport.port}${web.path}` });
              default:
                break;
            }
          }
          else {
            this._forward = HTTP.createForward({ prefix: `/a/${this._id}`, IP4Address: ipAddr, port: webport.port, path: web.path });
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
          this._dns = DNS.createForward({ _id: this._id, name: this._name, IP4Address: ipAddr, port: dnsport.port, options: typeof dnsport.dns === 'object' ? dnsport.dns : null });
        }

        this._mdnsRecords = [];
        this._netRecords = [];
        if (this._ports.length) {
          if (primary === 'home' && secondary === 'none') {
            await Promise.all(this._ports.map(async (port) => {
              if (port.mdns && port.mdns.type && port.mdns.type.split('.')[0]) {
                this._mdnsRecords.push(await MDNS.addRecord({
                  hostname: this._safeName(),
                  domainname: 'local',
                  ip: ipAddr,
                  port: port.port,
                  service: port.mdns.type,
                  txt: !port.mdns.txt ? [] : Object.keys(port.mdns.txt).map((key) => {
                    return `${key}=${port.mdns.txt[key]}`;
                  })
                }));
              }
            }));
          }
        }

      }

      config.Env = Object.keys(this._env).map(key => `${key}=${this.expand(this._env[key].value)}`).concat(configEnv);
      this._fullEnv = config.Env;

      if (inherit.container) {
        this._container = inherit.container;
        if (inherit.secondary.length) {
          this._secondaryContainers = inherit.secondary;
        }
      }
      else {
        const startup = [];

        this._container = await docker.createContainer(config);
        startup.push({ delay: this._delay, container: this._container });

        // Setup secondary containers
        if (this._secondary.length) {
          this._secondaryContainers = [];
          for (let c = 0; c < this._secondary.length; c++) {
            const secondary = this._secondary[c];
            const sconfig = {
              name: `${this._safeName()}__${this._id}__${c}`,
              Image: Images.withTag(secondary._image),
              Cmd: secondary._args,
              HostConfig: {
                Mounts: this._fs.getAllMounts(secondary),
                Devices: [],
                CapAdd: [],
                LogConfig: config.LogConfig,
                NetworkMode: `container:${this._helperContainer.id}`
              },
              Env: Object.keys(secondary._env).map(key => `${key}=${this.expand(secondary._env[key].value)}`)
            };
            this._secondaryContainers[c] = await docker.createContainer(sconfig);
            startup.push({ delay: secondary._delay, container: this._secondaryContainers[c] });
          }
        }

        // Start everything up in delay order
        startup.sort((a, b) => a.delay - b.delay);
        for (let i = 0; i < startup.length; i++) {
          const start = Date.now();
          try {
            await startup[i].container.start();
          }
          catch (e) {
            console.error(e);
          }
          if (i + 1 < startup.length) {
            const startuptime = Date.now() - start;
            const delaytime = (startup[i + 1].delay - startup[i].delay) * 1000;
            if (startuptime < delaytime) {
              await new Promise(resolve => setTimeout(resolve, delaytime - startuptime));
            }
          }
        }
      }

      if (this._image === Images.withTag(Images.MINKE_PRIVATE_NETWORK)) {
        this._monitorNetwork();
        this.on('update.network.status', this._updateNetworkStatus);
      }

      if (this._monitor.cmd) {
        this._statusMonitor = this._createMonitor(Object.assign({ event: 'update.monitor' }, this._monitor));
      }

      this._startTime = Date.now();

      this._setStatus('running');

      if (this._features.vpn) {
        MinkeApp.emit('net.create', { app: this });
      }
    }
    catch (e) {

      // Startup failed for some reason, so attempt to shutdown and cleanup.
      console.error(e);
      this.stop();

    }

    return this;
  },

  stop: async function() {

    this._setStatus('stopping');

    try {
      if (this._statusMonitor) {
        this._statusMonitor.shutdown();
        this._statusMonitor = null;
      }
    }
    catch (_) {
    }
    try {
      if (this._networkMonitor) {
        this._networkMonitor.shutdown();
        this._networkMonitor = null;
        this.off('update.network.status', this._updateNetworkStatus);
      }
    }
    catch (_) {
    }

    if (this._mdns) {
      await Promise.all(this._mdnsRecords.map(rec => MDNS.removeRecord(rec)));
      await Promise.all(this._netRecords.map(rec => MDNS.removeRecord(rec)));
      this._mdns = null;
      this._mdnsRecords = null;
    }

    if (this._dns) {
      DNS.removeForward(this._dns);
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

    if (this._homeIP) {
      DNS.unregisterHostIP(this._safeName(), this._homeIP);
      DNS.unregisterHostIP(`${this._globalId}${GLOBALDOMAIN}`, this._homeIP);
      if (this._features.ddns || this._ddns || this._ports.find(port => port.nat)) {
        DDNS.unregister(this);
      }
      this._homeIP = null;
    }
    this._privateIP = null;

    // Stop everything
    if (this._secondaryContainers) {
      await Promise.all(this._secondaryContainers.map(async c => {
        try {
          await c.stop();
        }
        catch (e) {
          console.error(e);
        }
      }));
    }
    if (this._container) {
      try {
        await this._container.stop();
      }
      catch (e) {
        console.error(e);
      }
    }
    if (this._helperContainer) {
      try {
        await this._helperContainer.stop();
      }
      catch (e) {
        console.error(e);
      }
    }

    // Log everything
    await new Promise(async (resolve) => {
      try {
        const log = await this._container.logs({
          follow: true,
          stdout: true,
          stderr: true
        });
        let outlog = '';
        let errlog = '';
        docker.modem.demuxStream(log,
          {
            write: (chunk) => {
              outlog += chunk.toString('utf8');
            }
          },
          {
            write: (chunk) => {
              errlog += chunk.toString('utf8');
            }
          }
        );
        log.on('end', () => {
          this._fs.saveLogs(outlog, errlog);
          resolve();
        });
      }
      catch (_) {
        resolve();
      }
    });

    // Remove everything
    const removing = [];
    if (this._secondaryContainers) {
      for (let c = 0; c < this._secondaryContainers.length; c++) {
        removing.push(this._secondaryContainers[c].remove());
      }
      this._secondaryContainers = null;
    }
    if (this._container) {
      removing.push(this._container.remove());
      this._container = null;
    }
    if (this._helperContainer) {
      removing.push(this._helperContainer.remove());
      this._helperContainer = null;
    }
    await Promise.all(removing.map(rm => rm.catch(e => console.log(e)))); // Ignore exceptions

    this._fs = null;

    this._setStatus('stopped');

    if (this._features.vpn) {
      MinkeApp.emit('net.create', { app: this });
    }

    return this;
  },

  restart: async function(reason) {
    if (this.isRunning()) {
      await this.stop();
    }
    await this.save();
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
      const nidx = networkApps.indexOf(this);
      if (nidx !== -1) {
        networkApps.splice(nidx, 1);
      }
    }
    if (this.isRunning()) {
      await this.stop();
    }

    // Create a new filesystem so we can uninstall. If the app wasn't running when we
    // uninstall then there was no file system available to use for this operation.
    Filesystem.create(this).uninstall();

    await Database.removeApp(this._id);

    MinkeApp.emit('app.remove', { app: this });
    if (this._willCreateNetwork()) {
      MinkeApp.emit('net.remove', { network: { _id: this._id, name: this._name } });
    }
  },

  getAvailableNetworks: function() {
    return [ { _id: 'home', name: 'home' } ].concat(networkApps.map((app) => {
      return (app && app._willCreateNetwork()) || (app === this && this._features.vpn) ? { _id: app._id, name: app._name } : null;
    }));
  },

  getAvailableShareables: function() {
    return applications.reduce((acc, app) => {
      if (app !== this) {
        const shares = [];
        function update(src) {
          src._binds.forEach(bind => {
            if (bind.shares && bind.shares.length) {
              shares.push(bind);
            }
          });
          src._customshares.forEach(bind => {
            if (bind.shares && bind.shares.length) {
              shares.push(bind);
            }
          });
        }
        update(app);
        app._secondary.forEach(secondary => update(secondary));

        if (shares.length) {
          acc.push({
            app: app,
            shares: shares
          });
        }
      }
      return acc;
    }, []);
  },

  getAvailableWebsites: function() {
    return applications.reduce((acc, app) => {
      if (app !== this && this._networks.primary === app._networks.primary) {
        const webport = app._ports.find(port => port.web);
        if (webport) {
          acc.push({
            app: app,
            port: webport
          });
        }
      }
      return acc;
    }, []);
  },

  expand: function(txt) {
    if (typeof txt ==='string' && txt.indexOf('{{') !== -1) {
      const env = Object.assign({
        __APPNAME: { value: this._name },
        __GLOBALNAME: { value: `${this._globalId}${GLOBALDOMAIN}` },
        __HOMEIP: { value: this._homeIP },
        __DOMAINNAME: { value: MinkeApp.getLocalDomainName() },
        __MACADDRESS: { value: MinkeApp._primaryMacAddress() }
      }, this._env);
      for (let key in env) {
        txt = txt.replace(new RegExp(`\{\{${key}\}\}`, 'g'), env[key].value);
      }
    }
    return txt;
  },

  _monitorNetwork: function() {
    this._networkMonitor = this._createMonitor({
      event: 'update.network.status',
      watch: '/etc/status/forwardports.txt',
      cmd: 'cat /etc/status/forwardports.txt',
      parser: 'output = input'
    });
  },

  _updateNetworkStatus: async function(status) {
    await Promise.all(this._netRecords.map(rec => MDNS.removeRecord(rec)));
    this._netRecords = [];
    await Promise.all(status.data.split(' ').map(async (port) => {
      port = port.split(':'); // ip:port:proto:mdns
      if (port[3]) {
        const mdns = JSON.parse(Buffer.from(port[3], 'base64').toString('utf8'));
        this._netRecords.push(await MDNS.addRecord({
          hostname: this._safeName(),
          domainname: 'local',
          ip: this._homeIP,
          service: mdns.type,
          port: parseInt(port[1]),
          txt: !mdns.txt ? [] : Object.keys(mdns.txt).map((key) => {
            return `${key}=${mdns.txt[key]}`;
          })
        }));
        if (mdns.type === '_minke._tcp') {
          // Remotely managed MinkeBox
          // ...
        }
      }
    }));
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

  isRunning: function() {
    return this._status === 'running';
  },

  _safeName: function() {
    return this._name.replace(/[^a-zA-Z0-9]/g, '');
  },

  _primaryMacAddress: function() {
    const r = this._globalId.split('-')[4];
    return `${r[0]}a:${r[2]}${r[3]}:${r[4]}${r[5]}:${r[6]}${r[7]}:${r[8]}${r[9]}:${r[10]}${r[11]}`;
  },

  _willCreateNetwork: function() {
    return (this._networks.primary === this._id || this._networks.secondary === this._id);
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
        if (state.data) {
          listener(state.data);
        }
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
                  const app = applications.find(app => {
                    if (app._container && app._container.id === id) {
                      return true;
                    }
                    else if (app._helperContainer && app._helperContainer.id === id) {
                      return true;
                    }
                    else if (app._secondaryContainers && app._secondaryContainers.find(c => c.id === id)) {
                      return true;
                    }
                    else {
                      return false;
                    }
                  });
                  if (app && app.isRunning()) {
                    // If the app is running we stop it (so we stop all the pieces). We will auto-restart
                    // as long as it has been running longer than CRASH_TIMEOUT.
                    app.stop().then(() => {
                      if (Date.now() - app._startTime > CRASH_TIMEOUT) {
                        app.start();
                      }
                    });
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

MinkeApp.startApps = async function(app, config) {

  koaApp = app;

  // Start DB
  await Database.init();

  // Find ourself
  (await docker.listContainers({})).forEach((container) => {
    if (container.Image.endsWith('/minke')) {
      MinkeApp._container = docker.getContainer(container.Id);
    }
  });

  // Get our IP
  MinkeApp._network = await Network.getActiveInterface();

  // Startup home network early (in background)
  Network.getHomeNetwork();

  // Monitor docker events
  MinkeApp._monitorEvents();

  const running = await docker.listContainers({ all: true });
  const runningNames = running.map(container => container.Names[0]);

  // Load all the apps
  applications = (await Database.getApps()).map((json) => {
    return new MinkeApp().createFromJSON(json);
  });
  // And networks
  networkApps = applications.reduce((acc, app) => {
    if (app._features.vpn) {
      acc.push(app);
    }
    return acc;
  }, []);
  // Setup at the top. We load this now rather than at the top of the file because it will attempt to load us
  // recursively (which won't work).
  const MinkeSetup = require('./MinkeSetup');
  setup = new MinkeSetup(await Database.getConfig('minke'), {
    HOSTNAME: 'MinkeBox',
    LOCALDOMAIN: 'home',
    DHCP: MinkeApp._network.dhcp,
    PORT: config.port || 80,
    IPADDRESS: MinkeApp._network.network.ip_address,
    GATEWAY: MinkeApp._network.network.gateway_ip,
    NETMASK: MinkeApp._network.netmask.mask,
    DNSSERVER1: '1.1.1.1',
    DNSSERVER2: '1.0.0.1',
    TIMEZONE: Moment.tz.guess(),
    ADMINMODE: 'DISABLED',
    GLOBALID: UUID(),
    UPDATETIME: '03:00',
    DISKS: { [process.env.ROOTDISK || 'sda']: '/minke' }
  });
  applications.unshift(setup);

  // Safe to start listening - only on the home network.
  app.listen({
    host: MinkeApp._network.network.ip_address,
    port: config.port || 80
  });

  // Stop or inherit apps if they're still running
  const inheritables = {};
  await Promise.all(applications.map(async (app) => {
    const aidx = runningNames.indexOf(`/${app._safeName()}__${app._id}`);
    const hidx = runningNames.indexOf(`/helper-${app._safeName()}__${app._id}`);
    const inherit = {
      container: aidx === -1 ? null : docker.getContainer(running[aidx].Id),
      helperContainer: hidx === -1 ? null : docker.getContainer(running[hidx].Id),
      secondary: []
    };
    for (let s = 0; s < app._secondary.length; s++) {
      const sidx = runningNames.indexOf(`/${app._safeName()}__${app._id}__${s}`);
      if (sidx === -1) {
        break;
      }
      inherit.secondary.push(docker.getContainer(running[sidx].Id));
    }
    // We can only inherit under specific circumstances
    if (config.inherit && ((inherit.container && inherit.helperContainer) || (inherit.container && app._networks.primary === 'host')) && inherit.secondary.length === app._secondary.length) {
      console.log(`Inheriting ${app._name}`);
      inheritables[app._id] = inherit;
    }
    else {
      if (inherit.container) {
        console.log(`Stopping ${app._name}`);
        await inherit.container.remove({ force: true });
      }
      if (inherit.helperContainer) {
        console.log(`Stopping helper-${app._name}`);
        await inherit.helperContainer.remove({ force: true });
      }
      await Promise.all(inherit.secondary.map((sec, idx) => {
        console.log(`Stopping ${app._name} secondary ${idx}`);
        return sec.remove({ force: true });
      }));
    }
  }));

  await setup.start();

  // Start up any Host network servers.
  await Promise.all(applications.map(async (app) => {
    try {
      if (app._networks.primary === 'host') {
        await app.start(inheritables[app._id]);
      }
    }
    catch (e) {
      console.error(e);
    }
  }));
  // Start up any VPNs. We want them to claim the lowest IP on their networks.
  await Promise.all(applications.map(async (app) => {
    try {
      if (app._willCreateNetwork() && app._status === 'stopped') {
        await app.start(inheritables[app._id]);
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
        await app.start(inheritables[app._id]);
      }
    }
    catch (e) {
      console.error(e);
    }
  }));
  // Restart any apps which have been marked
  await Promise.all(MinkeApp.needRestart().map(async (app) => {
    try {
      await app.restart();
    }
    catch (e) {
      console.error(e);
    }
  }));
}

MinkeApp.getAdminMode = function() {
  return setup ? setup.getAdminMode() : false;
}

MinkeApp.getLocalDomainName = function() {
  return setup ? setup.getLocalDomainName() : '';
}

MinkeApp.shutdown = async function(config) {
  await Promise.all(applications.map(async (app) => {
    if (app.isRunning()) {
      // If we shutdown with 'inherit' set, we leave the children running so we
      // can inherit them when on a restart.
      if (!config.inherit) {
        await app.stop();
        await app.save();
      }
    }
  }));
}

MinkeApp.create = async function(image) {
  const app = new MinkeApp().createFromSkeleton(await Skeletons.loadSkeleton(image, true));
  applications.push(app);
  if (app._features.vpn) {
    networkApps.push(app);
    MinkeApp.emit('net.create', { app: app });
  }
  await app.save();
  MinkeApp.emit('app.create', { app: app });

  return app;
}

MinkeApp.getApps = function() {
  return applications;
}

MinkeApp.getAppById = function(id) {
  return applications.find(app => app._id === id);
}

MinkeApp.getNetworks = function() {
  return [ { _id: 'home', name: 'home' } ].concat(networkApps.reduce((acc, app) => {
    if (app && app._willCreateNetwork()) {
      acc.push({ _id: app._id, name: app._name });
    }
    return acc;
  }, []));
}

MinkeApp.getTags = function() {
  return Object.keys(MinkeApp.getApps().reduce((acc, app) => {
    app._tags.forEach(tag => acc[tag] = true);
    return acc;
  }, { All: true }));
}

MinkeApp.needRestart = function() {
  return applications.reduce((acc, app) => {
    if (app._needRestart) {
      acc.push(app);
    }
    return acc;
  }, []);
}

module.exports = MinkeApp;
