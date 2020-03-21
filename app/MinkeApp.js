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
const Updater = require('./Updater');
const Disks = require('./Disks');
const Skeletons = require('./skeletons/Skeletons');
const ConfigBackup = require('./ConfigBackup');

const GLOBALDOMAIN = Config.GLOBALDOMAIN;

const CRASH_TIMEOUT = (2 * 60 * 1000); // 2 minutes
const HELPER_STARTUP_TIMEOUT = (30 * 1000) // 30 seconds

let applications = [];
let koaApp = null;
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
    this._backups = app.backups || [];
    this._networks = app.networks;
    this._bootcount = app.bootcount;
    this._secondary = (app.secondary || []).map(secondary => {
      return {
        _image: secondary.image,
        _args: secondary.args,
        _env: secondary.env,
        _features: secondary.features,
        _ports: secondary.ports,
        _binds: secondary.binds,
        _files: secondary.files,
        _backups: secondary.backups
      };
    });

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
      backups: this._backups,
      networks: this._networks,
      bootcount: this._bootcount,
      secondary: this._secondary.map(secondary => {
        return {
          image: secondary._image,
          args: secondary._args,
          env: secondary._env,
          features: secondary._features,
          ports: secondary._ports,
          binds: secondary._binds,
          files: secondary._files,
          backups: secondary._backups
        };
      })
    }
  },

  createFromSkeleton: function(skel) {
    for (let i = 0; ; i++) {
      const name = (i === 0 ? skel.name : `${skel.name} ${i}`);
      if (!applications.find(app => name === app._name)) {
        this._name = name;
        break;
      }
    }
    this._id = Database.newAppId();
    this._image = skel.image,
    this._globalId = UUID();
    this._backups = [];
    this._bootcount = 0;

    this.updateFromSkeleton(skel, {});

    this._setStatus('stopped');

    return this;
  },

  updateFromSkeleton: function(skel, defs) {

    this._description = skel.description;
    this._args = (skel.properties.find(prop => prop.type === 'Arguments') || {}).defaultValue;

    this._networks = {
      primary: 'none',
      secondary: 'none'
    };
    skel.properties.forEach(prop => {
      if (prop.type === 'Network') {
        if (defs.networks && defs.networks[prop.name]) {
          this._networks[prop.name] = defs.networks[prop.name];
        }
        else if (prop.defaultValue === '__create') {
          this._networks[prop.name] = this._id;
        }
        else if (prop.defaultValue) {
          this._networks[prop.name] = prop.defaultValue;
        }
      }
    });
    // Any created network must be secondary
    if (this._networks.primary === this._id) {
      this._networks.primary = this._networks.secondary;
      this._networks.secondary = this._id;
    }
    // If we only have one network, must be primary
    if (this._networks.primary === 'none') {
      this._networks.primary = secondary;
      this._networks.secondary = 'none';
    }
    // Remove duplicate secondary
    if (this._networks.primary === this._networks.secondary) {
      this._networks.secondary = 'none';
    }

    this._parseProperties(this, '', skel.properties, defs);
    if (skel.secondary) {
      this._secondary = skel.secondary.map((secondary, idx) => {
        const secondaryApp = {
          _image: secondary.image,
          _args: (secondary.properties.find(prop => prop.type === 'Arguments') || {}).defaultValue,
          _backups: [],
          _delay: secondary.delay || 0
        };
        this._parseProperties(secondaryApp, `${idx}`, secondary.properties, defs.secondary[idx] || {});
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
          let src = null;
          switch (prop.style) {
            case 'parent':
              const pbind = this._binds.find(pbind => pbind.target === targetname);
              if (pbind) {
                src = pbind.src;
              }
              else {
                src = null;
              }
              break;
            case 'boot':
            case 'store':
            default:
              if (bind && bind.src) {
                src = bind.src;
              }
              else {
                src = Filesystem.getNativePath(this._id, prop.style, `/dir${ext}/${targetname}`);
              }
              break;
            case 'temp':
              src = null;
              break;
          }
          const b = {
            src: src,
            target: targetname,
            description: prop.description || targetname,
            backup: prop.backup
          };
          if (bind && bind.shares.length) {
            b.shares = bind.shares;
          }
          else {
            b.shares = prop.shares || [];
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

  _updateIfBuiltin: function() {
    const skel = Skeletons.loadSkeleton(this._image, false);
    if (!skel || skel.type !== 'builtin') {
      return false;
    }
    const before = this.toJSON();
    this.updateFromSkeleton(skel.skeleton, before);
    if (JSON.stringify(before) == JSON.stringify(this.toJSON())) {
      return false;
    }
    return true;
  },

  start: async function(inherit) {

    try {
      this._setStatus('starting');

      if (this._willCreateNetwork()) {
        MinkeApp.emit('net.create', { app: this });
      }

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
          CapDrop: [],
          LogConfig: {
            Type: 'json-file',
            Config: {
              'max-file': '1',
              'max-size': '100k'
            }
          },
          Sysctls: {}
        }
      };

      const configEnv = [];

      // Create network environment
      const netEnv = {};
      if (this._networks.primary !== 'none') {
        switch (this._networks.primary) {
          case 'home':
            netEnv.DHCP_INTERFACE = 0;
            netEnv.NAT_INTERFACE = 0;
            netEnv.DEFAULT_INTERFACE = 0;
            break;
          case 'host':
            netEnv.DEFAULT_INTERFACE = 0;
            break;
          default:
            netEnv.INTERNAL_INTERFACE = 0;
            netEnv.DEFAULT_INTERFACE = 0;
            break;
        }
        if (this._networks.secondary !== 'none') {
          switch (this._networks.secondary) {
            case 'home':
              netEnv.SECONDARY_INTERFACE = 1;
              netEnv.DHCP_INTERFACE = 1;
              netEnv.NAT_INTERFACE = 1;
              break;
            default:
              netEnv.SECONDARY_INTERFACE = 1;
              netEnv.INTERNAL_INTERFACE = 1;
              break;
          }
        }
      }
      for (let eth in netEnv) {
        configEnv.push(`__${eth}=eth${netEnv[eth]}`);
      }

      switch (this._networks.primary) {
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
          this._defaultIP = this._homeIP;
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
          const vpn = await Network.getPrivateNetwork(this._networks.primary);
          config.HostConfig.NetworkMode = vpn.id;
          const dns = vpn.info.IPAM.Config[0].Gateway.replace(/\.\d$/,'.2');
          configEnv.push(`__DNSSERVER=${dns}`);
          configEnv.push(`__GATEWAY=${dns}`);
          config.HostConfig.Dns = [ dns ];
          config.HostConfig.DnsSearch = [ 'local.' ];
          config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:1', 'attempts:1' ];
          // When we start a new app which is attached to a private network, we must restart the
          // private network so it can inform the peer about the new app.
          const napp = MinkeApp.getAppById(this._networks.primary);
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
      }

      if (this._features.privileged) {
        config.HostConfig.Privileged = true;
      }

      // Add supported capabilities
      [ '+SYS_MODULE','+SYS_RAWIO','+SYS_PACCT','+SYS_ADMIN','+SYS_NICE','+SYS_RESOURCE','+SYS_TIME','+SYS_TTY_CONFIG',
        '+AUDIT_CONTROL','+MAC_ADMIN','+MAC_OVERRIDE','+NET_ADMIN','+SYSLOG','+DAC_READ_SEARCH','+LINUX_IMMUTABLE',
        '+NET_BROADCAST','+IPC_LOCK','+IPC_OWNER','+SYS_PTRACE','+SYS_BOOT','+LEASE','+WAKE_ALARM','+BLOCK_SUSPEND' ].forEach(cap => {
        if (this._features[cap]) {
          config.HostConfig.CapAdd.push(cap.substring(1));
        }
      });

      [ '-SETPCAP','-MKNOD','-AUDIT_WRITE','-CHOWN','-NET_RAW','-DAC_OVERRIDE','-FOWNER','-FSETID','-KILL','-SETGID',
        '-SETUID','-NET_BIND_SERVICE','-SYS_CHROOT','-SETFCAP' ].forEach(cap => {
          if (this._features[cap]) {
            config.HostConfig.CapDrop.push(cap.substring(1));
          }
        });

      if (this._features.vpn || this._willCreateNetwork()) {
        config.HostConfig.Sysctls["net.ipv4.ip_forward"] = "1";
      }

      if (this._networks.primary !== 'host') {

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

        if (this._networks.primary === 'home' || this._networks.secondary === 'home') {
          const ip6 = this.getSLAACAddress();
          if (ip6) {
            helperConfig.Env.push(`__HOSTIP6=${ip6}`);
          }
        }

        this._ddns = this._features.ddns || false;
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

        if (this._features.vpn) {
          helperConfig.Env.push(`FETCH_REMOTE_IP=tun`);
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
          try {
            await this._helperContainer.start();
          }
          catch (e) {
            console.error('Error starting helper');
            console.error(e);
            throw e;
          }

          // Attach new helper to secondary network if necessary
          if (this._networks.primary != 'none') {
            switch (this._networks.secondary) {
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
                  console.error('Error connecting home network');
                  console.error(e);
                }
                break;
              }
              default:
              {
                const vpn = await Network.getPrivateNetwork(this._networks.secondary);
                try {
                  await vpn.connect({
                    Container: this._helperContainer.id
                  });
                }
                catch (e) {
                  // Sometimes we get an error setting up the gateway, but we don't want it to set the gateway anyway so it's safe
                  // to ignore.
                  console.error('Error connecting private network');
                  console.error(e);
                }
                break;
              }
            }
          }
        }

        // Wait while the helper configures everything.
        if (!await this._monitorHelper()) {
          // Helper failed to startup cleanly - abort
          this.stop();
          return this;
        }

        if (this._homeIP) {
          const homeip6 = this.getSLAACAddress();
          Network.registerIP(this._homeIP);
          DNS.registerHostIP(this._safeName(), this._homeIP, homeip6);
          DNS.registerGlobalIP(`${this._globalId}${GLOBALDOMAIN}`, this._homeIP, homeip6);
        }

        // If we need to be accessed remotely, register with DDNS
        if (this._ddns) {
          DDNS.register(this);
        }

      }

      const ports = this._ports.map(port => this.expandPort(port));
      if (this._defaultIP) {
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
            this._forward = HTTP.createForward({ prefix: `/a/${this._id}`, IP4Address: this._defaultIP, port: webport.port, path: web.path });
          }
          if (this._forward.http) {
            koaApp.use(this._forward.http);
          }
          if (this._forward.ws) {
            koaApp.ws.use(this._forward.ws);
          }
        }
      }

      if (this._homeIP) {
        const dnsport = ports.find(port => port.dns);
        if (dnsport) {
          this._dns = DNS.createForward({ _id: this._id, name: this._name, IP4Address: this._homeIP, port: dnsport.port, options: typeof dnsport.dns === 'object' ? dnsport.dns : null });
        }
      }

      this._mdnsRecords = [];
      this._netRecords = [];
      if (this._homeIP) {
        await Promise.all(ports.map(async (port) => {
          if (port.mdns && port.mdns.type && port.mdns.type.split('.')[0]) {
            this._mdnsRecords.push(await MDNS.addRecord({
              hostname: this._safeName(),
              domainname: 'local',
              ip: this._homeIP,
              port: port.port,
              service: port.mdns.type,
              txt: !port.mdns.txt ? [] : Object.keys(port.mdns.txt).map((key) => {
                return `${key}=${port.mdns.txt[key]}`;
              })
            }));
          }
        }));
      }

      config.Env = Object.keys(this._env).map(key => `${key}=${this.expandEnv(this._env[key].value)}`).concat(configEnv);
      this._fullEnv = config.Env;

      // Setup timezone
      if (this._features.localtime) {
        config.HostConfig.Mounts.push({
          Type: 'bind',
          Source: '/usr/share/zoneinfo',
          Target: '/usr/share/zoneinfo',
          BindOptions: {
            Propagation: 'rshared'
          },
          ReadOnly: true
        });
        config.Env.push(`TZ=${this.getTimezone()}`);
      }

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
            const secondaryMounts = this._fs.getAllMounts(secondary);
            this._allmounts = this._allmounts.concat(secondaryMounts);
            const sconfig = {
              name: `${this._safeName()}__${this._id}__${c}`,
              Image: Images.withTag(secondary._image),
              Cmd: secondary._args,
              HostConfig: {
                Mounts: secondaryMounts,
                Devices: [],
                CapAdd: [],
                CapDrop: [],
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
      if (this._ddns) {
        DDNS.unregister(this);
      }
      Network.unregisterIP(this._homeIP);
      this._homeIP = null;
    }

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
    const getLogs = async (container) => {
      try {
        const log = await container.logs({
          follow: true,
          stdout: true,
          stderr: true
        });
        let outlog = '';
        let errlog = '';
        return new Promise(resolve => {
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
            resolve({ out: outlog, err: errlog });
          });
        });
      }
      catch (_) {
        return { out: '', err: '' };
      }
    }

    if (this._container) {
      const logs = await getLogs(this._container);
      this._fs.saveLogs(logs.out, logs.err, '');
    }
    if (this._helperContainer) {
      const logs = await getLogs(this._helperContainer);
      this._fs.saveLogs(logs.out, logs.err, '_helper');
    }
    if (this._secondaryContainers) {
      await Promise.all(this._secondaryContainers.map(async (container, idx) => {
        const logs = await getLogs(container);
        this._fs.saveLogs(logs.out, logs.err, `_${idx}`);
      }));
    }

    this._unmonitorHelper();

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

    if (this._fs && this._allmounts) {
      this._fs.unmountAll(this._allmounts);
    }
    this._fs = null;

    this._setStatus('stopped');

    if (this._willCreateNetwork()) {
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

  checkInstalled: async function() {
    const images = [
      Images.withTag(Images.MINKE_HELPER),
      Images.withTag(this._image)
    ];
    this._secondary.forEach(secondary => images.push(Images.withTag(secondary._image)));

    let fail = false;
    for (let i = 0; i < images.length && !fail; i++) {
      try {
        await docker.getImage(images[i]).inspect();
      }
      catch (_) {
        fail = true;
      }
    }
    if (fail) {
      await Updater.updateApp(this);
    }
  },

  uninstall: async function() {
    const idx = applications.indexOf(this);
    if (idx !== -1) {
      applications.splice(idx, 1);
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
    return MinkeApp.getNetworks();
  },

  getAvailableShareables: function() {
    return applications.reduce((acc, app) => {
      if (app !== this) {
        const shares = [];
        function update(src) {
          src._binds.forEach(bind => {
            // Include bindings with shares which aren't bound to other things
            if (bind.shares && bind.shares.length && !bind.shares.find(share => !!share.src)) {
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

  getAvailableWebsites: function(network) {
    return applications.reduce((acc, app) => {
      if (app !== this && network === app._networks.primary) {
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

  getTimezone: function() {
    return setup ? setup.getTimezone() : 'UTC';
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
        __IPV6ENABLED: { value : this.getSLAACAddress() ? 'true' : 'false' },
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

  _monitorHelper: async function() {
    this._helperLog = await this._helperContainer.logs({
      follow: true,
      stdout: true,
      stderr: false
    });
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this._helperLog.destroy();
        this._helperLog = null;
        resolve(false);
      }, HELPER_STARTUP_TIMEOUT);
      docker.modem.demuxStream(this._helperLog, {
        write: (data) => {
          data = data.toString('utf8');
          let idx = data.indexOf('MINKE:DHCP:IP ');
          if (idx !== -1) {
            this._homeIP = data.replace(/.*MINKE:DHCP:IP (.*)\n.*/, '$1');
          }
          idx = data.indexOf('MINKE:DEFAULT:IP ');
          if (idx !== -1) {
            this._defaultIP = data.replace(/.*MINKE:DEFAULT:IP (.*)\n.*/, '$1');
          }
          idx = data.indexOf('MINKE:REMOTE:IP ');
          if (idx !== -1) {
            this._remoteIP = data.replace(/.*MINKE:REMOTE:IP (.*)\n.*/, '$1');
          }
          if (data.indexOf('MINKE:UP') !== -1) {
            clearTimeout(timeout);
            resolve(true);
          }
        }
      }, null);
    });
  },

  _unmonitorHelper: function() {
    if (this._helperLog) {
      this._helperLog.destroy();
      this._helperLog = null;
    }
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
    UPDATETIME: '03:00'
  });
  applications.unshift(setup);

  // Safe to start listening - only on the home network.
  const server = app.listen({
    host: MinkeApp._network.network.ip_address,
    port: config.port || 80
  });
  //server.keepAliveTimeout = 0;

  // Save current config
  await ConfigBackup.save();

  // Setup Disks
  await Disks.init();

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
    if (config.inherit && ((inherit.container && inherit.helperContainer) || (inherit.container && app._networks.primary === 'host')) && inherit.secondary.length === app._secondary.length && app._updateIfBuiltin() === false) {
      console.log(`Inheriting ${app._name}`);
      inheritables[app._id] = inherit;
    }
    else {
      if (inherit.container) {
        console.log(`Stopping ${app._safeName()}`);
        try {
          await inherit.container.remove({ force: true });
        }
        catch (e) {
          console.error(e);
        }
      }
      if (inherit.helperContainer) {
        console.log(`Stopping helper-${app._safeName()}`);
        try {
          await inherit.helperContainer.remove({ force: true });
        }
        catch (e) {
          console.error(e);
        }
      }
      await Promise.all(inherit.secondary.map(async (sec, idx) => {
        console.log(`Stopping ${app._safeName()}__${idx}`);
        try {
          await sec.remove({ force: true });
        }
        catch (e) {
          console.error(e);
        }
      }));
      await app.save();
    }
  }));

  await setup.start();

  // Startup applications in order
  const order = MinkeApp.getStartupOrder();
  for (let i = 0; i < order.length; i++) {
    try {
      const app = order[i];
      if (app._status === 'stopped') {
        await app.checkInstalled();
        await app.start(inheritables[app._id]);
      }
    }
    catch (e) {
      console.error(e);
    }
  }

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

MinkeApp.getStartupOrder = function() {
  const order = [];
  const list = [].concat(applications);

  // Start with all the 'host' applications.
  for (let i = 0; i < list.length; ) {
    if (list[i]._networks.primary === 'host' && list[i]._networks.secondary === 'none') {
      order.push(list[i]);
      list.splice(i, 1);
    }
    else {
      i++;
    }
  }

  // Now with the base networks (or none), add applications which depend on already existing networks.
  // If apps create networks, they are added after any neworks they depend on.
  const networks = {
    none: true, host: true, home: true
  };
  let len;
  do {
    len = list.length;
    let i = 0;
    while (i < list.length) {
      const app = list[i];
      if ((networks[app._networks.primary] || app._networks.primary === app._id) &&
          (networks[app._networks.secondary] || app._networks.secondary === app._id)) {
        networks[app._networks.primary] = true;
        networks[app._networks.secondary] = true;
        order.push(app);
        list.splice(i, 1);
      }
      else {
        i++;
      }
    }
  } while (list.length < len);
  // Repeat as long as the list gets shorted. Once it stops we either have ordered everything, or somehow have applications
  // which are dependent on things that don't exist. Let's not start those.

  return order;
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
  if (app._willCreateNetwork()) {
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
  const networks = [ { _id: 'home', name: 'home' } ];
  applications.forEach(app => {
    if (app._willCreateNetwork()) {
      networks.push({ _id: app._id, name: app._name });
    }
  });
  return networks;
}

MinkeApp.getTags = function() {
  const tags = [];
  applications.forEach(app => {
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
