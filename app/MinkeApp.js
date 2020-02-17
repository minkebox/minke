const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const Path = require('path');
const Moment = require('moment-timezone');
const UUID = require('uuid/v4');
const Config = require('./Config');
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
const ConfigBackup = require('./ConfigBackup');

const GLOBALDOMAIN = Config.GLOBALDOMAIN;

const CRASH_TIMEOUT = (2 * 60 * 1000); // 2 minutes
const HELPER_STARTUP_TIMEOUT = (30 * 1000) // 30 seconds

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
    this._backups = app.backups || [];
    this._networks = app.networks;
    this._bootcount = app.bootcount;
    this._secondary = app.secondary || [];

    // FIX
    if (!Array.isArray(this._args)) {
      this._args = undefined;
    }
    // FIX

    const skel = Skeletons.loadSkeleton(this._image, false);
    if (skel) {
      this._monitor = skel.skeleton.monitor || {};
      this._delay = skel.skeleton.delay || 0;
      this._tags = (skel.skeleton.tags || []).concat([ 'All' ]);
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
      backups: this._backups,
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
    this._shares = [];
    this._customshares = [];
    this._backups = [];
    this._bootcount = 0;

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
    this._monitor = skel.monitor || {};
    this._delay = skel.delay || 0;
    this._tags = (skel.tags || []).concat([ 'All' ]);

    return this;
  },

  _parseProperties: function(target, ext, properties, defs) {
    target._env = {};
    target._features = {};
    target._ports = [];
    target._binds = [];
    target._files = [];
    properties.forEach(prop => {
      switch (prop.type) {
        case 'Environment':
        {
          const found = (defs.env || {})[prop.name];
          if (found) {
            target._env[prop.name] = { value: found.value };
            if ('altValue' in found) {
              target._env[prop.name].altValue = found.altValue;
            }
          }
          else if ('defaultValue' in prop) {
            target._env[prop.name] = { value: prop.defaultValue };
          }
          else {
            target._env[prop.name] = { value: '' };
          }
          if ('defaultAltValue' in prop) {
            target._env[prop.name].altValue = prop.defaultAltValue;
          }
          break;
        }
        case 'Directory':
        {
          const targetname = Path.normalize(prop.name);
          const bind = defs.binds && defs.binds.find(bind => bind.target === targetname);
          const x = prop.style === 'parent' ? '' : ext;
          const b = {
            src: Filesystem.getNativePath(this._id, prop.style, `/dir${x}/${targetname}`),
            target: targetname,
            description: prop.description || targetname,
            backup: prop.backup

          };
          if (bind) {
            b.shares = bind.shares;
          }
          else if ('shares' in prop) {
            b.shares = prop.shares;
          }
          else {
            b.shares = [];
          }
          target._binds.push(b);
          break;
        }
        case 'File':
        {
          const targetname = Path.normalize(prop.name);
          const file = (defs.files && defs.files.find(file => file.target === targetname)) || {};
          const f = {
            src: Filesystem.getNativePath(this._id, prop.style, `/file${ext}/${prop.name.replace(/\//g, '_')}`),
            target: targetname,
            mode: prop.mode || 0o666,
            backup: prop.backup
          };
          if (file.data) {
            f.data = file.data;
          }
          else if ('defaultValue' in prop) {
            f.data = prop.defaultValue;
          }
          else {
            f.data = '';
          }
          if (file.altData) {
            f.altData = file.altData;
          }
          else if ('defaultAltValue' in prop) {
            f.altData = prop.defaultAltValue;
          }
          target._files.push(f);
          break;
        }
        case 'Feature':
        {
          target._features[prop.name] = true;
          break;
        }
        case 'Port':
        {
          target._ports.push({
            target: prop.name,
            port: prop.port,
            protocol: prop.protocol,
            web: prop.web,
            dns: prop.dns,
            nat: prop.nat,
            mdns: prop.mdns
          });
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
      this._allmounts = this._fs.getAllMounts(this);

      const config = {
        name: `${this._safeName()}__${this._id}`,
        Hostname: this._safeName(),
        Image: Images.withTag(this._image),
        Cmd: this._args,
        HostConfig: {
          Mounts: this._allmounts,
          Devices: [],
          CapAdd: [],
          LogConfig: {
            Type: 'json-file',
            Config: {
              'max-file': '1',
              'max-size': '10k'
            }
          },
          Sysctls: {}
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

      switch (primary) {
        case 'none':
          config.HostConfig.NetworkMode = 'none';
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
          if (this.getIP6()) {
            config.HostConfig.Sysctls["net.ipv6.conf.all.disable_ipv6"] = "0";
          }
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
          const dns = vpn.info.IPAM.Config[0].Gateway.replace(/\.\d$/,'.2');
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
      switch (secondary) {
        case 'none':
        case 'home':
          break;
        default:
          if (this._willCreateNetwork()) {
            const vpn = await Network.getPrivateNetwork(secondary);
            const ip = vpn.info.IPAM.Config[0].Gateway.replace(/\.\d$/,'.2');
            configEnv.push(`__PRIVATE_INTERFACE_IP=${ip}`);
          }
          break;
      }

      configEnv.push(`__GLOBALID=${this._globalId}`);

      if (this._features.vpn) {
        config.HostConfig.Devices.push({
          PathOnHost: '/dev/net/tun',
          PathInContainer: '/dev/net/tun',
          CgroupPermissions: 'rwm'
        });
        config.HostConfig.Sysctls["net.ipv4.ip_forward"] = "1";
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
          Env: Object.keys(this._env).map(key => `${key}=${this.expandEnv(this._env[key].value)}`).concat(configEnv)
        };

        if (primary === 'home' || secondary === 'home') {
          helperConfig.Env.push('ENABLE_DHCP=1');
          const ip6 = this.getSLAACAddress();
          if (ip6) {
            helperConfig.Env.push(`__HOSTIP6=${ip6}`);
          }
        }

        this._ddns = false;
        if (this._ports.length) {
          const nat = this._ports.reduce((acc, port) => {
            port = this.expandPort(port);
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

          // Attach new helper to secondary network if necessary
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
                  console.error(e);
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
                  console.error(e);
                }
                break;
              }
            }
          }
        }

        // Wait while the helper configures everything.
        const log = await this._helperContainer.logs({
          follow: true,
          stdout: true,
          stderr: false
        });
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              log.destroy();
              reject();
            }, HELPER_STARTUP_TIMEOUT);
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
                  clearTimeout(timeout);
                  resolve();
                }
              }
            }, null);
          });
        }
        catch (e) {
          // Helper failed to startup cleanly - abort
          console.error(e);
          this.stop();
          return this;
        }

        if (this._homeIP) {
          const homeip6 = this.getSLAACAddress();
          Network.registerIP(this._homeIP);
          DNS.registerHostIP(this._safeName(), this._homeIP, homeip6);
          DNS.registerGlobalIP(`${this._globalId}${GLOBALDOMAIN}`, this._homeIP, homeip6);
           // If we need to be accessed remotely, register with DDNS
          if (this._features.ddns || this._ddns || this._ports.find(port => this.expandPort(port).nat)) {
            DDNS.register(this);
          }
        }

      }

      const ipAddr = this._homeIP || this._privateIP;
      if (ipAddr) {

        const ports = this._ports.map(port => this.expandPort(port));
        const webport = ports.find(port => port.web);
        if (webport) {
          let web = webport.web;
          if (this._homeIP) {
            switch (web.type) {
              case 'newtab':
                this._forward = HTTP.createNewTab({ prefix: `/a/${this._id}`, url: `http${webport.port === 443 ? 's' : ''}://${this._safeName()}.${MinkeApp.getLocalDomainName()}:${webport.port}${web.path}` });
                break;
              case 'redirect':
                this._forward = HTTP.createRedirect({ prefix: `/a/${this._id}`, url: `http${webport.port === 443 ? 's' : ''}://${this._safeName()}.${MinkeApp.getLocalDomainName()}:${webport.port}${web.path}` });
                break;
              case 'url':
                this._forward = HTTP.createNewTab({ prefix: `/a/${this._id}`, url: web.url });
                break;
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

        const dnsport = ports.find(port => port.dns);
        if (dnsport) {
          this._dns = DNS.createForward({ _id: this._id, name: this._name, IP4Address: ipAddr, port: dnsport.port, options: typeof dnsport.dns === 'object' ? dnsport.dns : null });
        }

        this._mdnsRecords = [];
        this._netRecords = [];
        if (ports.length) {
          if (primary === 'home' && secondary === 'none') {
            await Promise.all(ports.map(async (port) => {
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

      config.Env = Object.keys(this._env).map(key => `${key}=${this.expandEnv(this._env[key].value)}`).concat(configEnv);
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
          const secondaryMounts = this._fs.getAllMounts(secondary);
          this._allmounts = this._allmounts.concat(secondaryMounts);
          for (let c = 0; c < this._secondary.length; c++) {
            const secondary = this._secondary[c];
            const sconfig = {
              name: `${this._safeName()}__${this._id}__${c}`,
              Image: Images.withTag(secondary._image),
              Cmd: secondary._args,
              HostConfig: {
                Mounts: secondaryMounts,
                Devices: [],
                CapAdd: [],
                LogConfig: config.LogConfig,
                NetworkMode: `container:${this._helperContainer.id}`
              },
              Env: Object.keys(secondary._env).map(key => `${key}=${this.expandEnv(secondary._env[key].value)}`)
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
        this._statusMonitor = this._createMonitor(this._monitor);
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

    this._statusMonitor = null;
    try {
      if (this._networkMonitor) {
        this._networkMonitor = null;
        this.off('update.network.status', this._updateNetworkStatus);
      }
    }
    catch (e) {
      console.error(e);
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
      DNS.unregisterHostIP(this._safeName());
      DNS.unregisterGlobalIP(`${this._globalId}${GLOBALDOMAIN}`);
      if (this._features.ddns || this._ddns || this._ports.find(port => this.expandPort(port).nat)) {
        DDNS.unregister(this);
      }
      Network.unregisterIP(this._homeIP);
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
        if (!this._container) {
          resolve();
        }
        else {
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
      }
      catch (e) {
        console.error(e);
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

    if (this._fs) {
      this._fs.unmountAll(this._allmounts);
    }
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

  getAvailableBackups: function() {
    return applications.reduce((acc, app) => {
      let backups = false;
      function backup(src) {
        src._binds.forEach(bind => backups |= bind.backup);
        src._files.forEach(bind => backups |= bind.backup);
      }
      backup(app);
      app._secondary.forEach(secondary => backup(secondary));

      if (backups) {
        acc.push({ app: app });
      }
      return acc;
    }, []);
  },

  getAvailableWebsites: function() {
    return applications.reduce((acc, app) => {
      if (app !== this && this._networks.primary === app._networks.primary) {
        const webport = app._ports.find(port => this.expandPort(port).web);
        if (webport) {
          acc.push({
            app: app,
            port: this.expandPort(webport)
          });
        }
      }
      return acc;
    }, []);
  },

  getIP6: function() {
    return setup ? setup.getIP6() : false;
  },

  getNATIP6: function() {
    return setup ? setup.getNATIP6() : false;
  },

  getSLAACAddress: function() {
    return Network.generateSLAACAddress(this._primaryMacAddress());
  },

  getWebLink: function() {
    if (this._forward) {
      return { url: this._forward.url, target: this._forward.target };
    }
    const port = this._ports.map(port => this.expandPort(port)).find(port => port.web);
    if (!port) {
      return {};
    }
    if (this._networks.primary === 'home' || this._networks.secondary === 'home') {
      return { url: `/a/${this._id}`, target: port.web === 'newtab' ? '_blank' : null };
    }
    return {};
  },

  expand: function(txt) {
    if (typeof txt ==='string' && txt.indexOf('{{') !== -1) {
      let addresses = '<none>';
      if (this._homeIP) {
        if (this.getSLAACAddress()) {
          addresses = `${this._homeIP} and ${this.getSLAACAddress()}`;
        }
        else {
          addresses = this._homeIP;
        }
      }
      const env = Object.assign({
        __APPNAME: { value: this._name },
        __GLOBALNAME: { value: `${this._globalId}${GLOBALDOMAIN}` },
        __HOMEIP: { value: this._homeIP || '<none>' },
        __HOMEIP6: { value: this.getSLAACAddress() || '<none>' },
        __HOMEADDRESSES: { value: addresses },
        __DOMAINNAME: { value: MinkeApp.getLocalDomainName() },
        __MACADDRESS: { value: this._primaryMacAddress().toUpperCase() }

      }, this._env);
      for (let key in env) {
        txt = txt.replace(new RegExp(`\{\{${key}\}\}`, 'g'), env[key].value);
      }
    }
    return txt;
  },

  expandEnv: function(val) {
    return this.expand(val);
  },

  expandPort: function(port) {
    let web = port.web;
    if (web === null || web === undefined || web === false) {
      web = null;
    }
    else if (web === true) {
      web = {
        type: 'redirect', // newtab, redirect, url
        path: ''
      };
    }
    else if (typeof web === 'string') {
      web = {
        type: web,
        path: ''
      }
    }
    else if (typeof web === 'object') {
      switch (web.type) {
        case 'url':
          web = {
            type: web.type,
            url: this.expand(web.url)
          };
          break;
        case 'redirect':
        case 'newtab':
          web = {
            type: web.type,
            path: this.expand(web.path)
          };
          break;
        default:
          break;
      }
    }
    else {
      web = null;
    }
    const nport = {
      target: port.name,
      port: this._expandNumber(port.port, port.defaultPort || 0),
      protocol: port.protocol,
      web: web,
      dns: this._expandBool(port.dns),
      nat: this._expandBool(port.nat),
      mdns: port.mdns
    };
    return nport;
  },

  _expandNumber: function(val, alt) {
    if (typeof val === 'number') {
      return val;
    }
    if (typeof val === 'string') {
      val = parseFloat(this.expand(val));
      if (typeof val === 'number' && !isNaN(val)) {
        return val;
      }
    }
    return alt;
  },

  _expandBool: function(val) {
    if (typeof val !== 'string') {
      return !!val;
    }
    val = this.expand(val);
    if (val == 'false' || parseFloat(val) == 0) {
      return false;
    }
    // Need better solution here!
    if (val === 'false&false' || val === 'false&true' || val === 'true&false' || val === 'false|false') {
      return false;
    }
    return true;
  },

  _monitorNetwork: function() {
    this._networkMonitor = this._createMonitor({
      event: 'update.network.status',
      polling: 60,
      cmd: 'cat /etc/status/forwardports.txt'
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
    return Monitor.create({
      app: this,
      cmd: args.cmd,
      parser: args.parser,
      template: args.template,
      polling: args.polling
    });;
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
                case 'health_status: unhealthy':
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
                case 'create':
                case 'start':
                case 'stop':
                case 'destroy':
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
        catch (e) {
          console.error(e);
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

  // See if we have wifi (in background)
  Network.wifiAvailable();

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
    IP6: false,
    NATIP6: false,
    WIFIENABLED: false,
    WIFINAME: '',
    WIFIPASSWORD: '',
    DNSSERVER1: '1.1.1.1',
    DNSSERVER2: '1.0.0.1',
    DNSSECURE: '',
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

  // Save current config
  await ConfigBackup.save();

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

MinkeApp.getAdvancedMode = function() {
  return setup ? setup.getAdvancedMode() : false;
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
  const app = new MinkeApp().createFromSkeleton((await Skeletons.loadSkeleton(image, true)).skeleton);
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
  const tags = [];
  MinkeApp.getApps().forEach(app => {
    app._tags.forEach(tag => {
      if (tag !== 'All' && tags.indexOf(tag) === -1) {
        tags.push(tag);
      }
    });
  });
  tags.sort((a, b) => a.localeCompare(b));
  return [ 'All' ].concat(tags);
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
