const Path = require('path');
const ChildProcess = require('child_process');
const Crypto = require('crypto');
const Moment = require('moment-timezone');
const UUID = require('uuid/v4');
const JSInterpreter = require('js-interpreter');
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
const Pull = require('./Pull');
const Disks = require('./Disks');
const UPNP = require('./UPNP');
const System = require('./System');
const Skeletons = require('./Skeletons');
const ConfigBackup = require('./ConfigBackup');

const GLOBALDOMAIN = Config.GLOBALDOMAIN;

const CRASH_TIMEOUT = (2 * 60 * 1000); // 2 minutes
const HELPER_STARTUP_TIMEOUT = (30 * 1000); // 30 seconds
const JSINTERPRETER_STEPS = 100;

let applications = [];
let koaApp = null;
let setup = null;

function MinkeApp() {
}

MinkeApp.prototype = {

  createFromJSON: function(app) {

    this._id = app._id;
    this._globalId = app.globalId;
    this._name = app.name;
    this._description = app.description;
    this._image = app.image;
    this._skeletonId = app.skeletonId;
    this._args = app.args;
    this._env = app.env;
    this._features = app.features,
    this._ports = app.ports;
    this._binds = app.binds;
    this._files = app.files;
    this._backups = app.backups || [];
    this._networks = app.networks;
    this._bootcount = app.bootcount;
    this._position = app.position || { tab: 0, widget: 0 };
    this._secondary = (app.secondary || []).map(secondary => {
      return {
        _image: secondary.image,
        _skeletonId: secondary.skeletonId,
        _args: secondary.args,
        _env: secondary.env,
        _features: secondary.features,
        _ports: secondary.ports,
        _binds: secondary.binds,
        _files: secondary.files,
        _backups: secondary.backups
      };
    });

    const skel = Skeletons.loadSkeleton(this.skeletonId(), false);
    if (skel) {
      this._skeleton = skel.skeleton;
      this._monitor = skel.skeleton.monitor || {};
      this._delay = skel.skeleton.delay || 0;
      this._tags = (skel.skeleton.tags || []).concat([ 'All' ]);
    }
    else {
      this._skeleton = null;
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
      skeletonId: this._skeletonId,
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
      position: this._position,
      secondary: this._secondary.map(secondary => {
        return {
          image: secondary._image,
          skeletonId: secondary._skeletonId,
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

  createFromSkeleton: async function(skel) {
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
    this._position = { tab: 0, widget: 0 };
    this._skeleton = skel;

    await this.updateFromSkeleton(skel, {});

    this._setStatus('stopped');

    return this;
  },

  updateFromSkeleton: async function(skel, defs) {

    this._skeletonId = skel.uuid;
    this._description = skel.description;
    this._args = (skel.properties.find(prop => prop.type === 'Arguments') || {}).defaultValue;

    this._networks = {
      primary: 'none',
      secondary: 'none'
    };
    skel.properties.forEach(prop => {
      if (prop.type === 'Network') {
        if (prop.defaultValue === '__create') {
          this._networks[prop.name] = this._id;
        }
        else if (defs.networks && defs.networks[prop.name]) {
          this._networks[prop.name] = defs.networks[prop.name];
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
      this._networks.primary = this._networks.secondary;
      this._networks.secondary = 'none';
    }
    // Remove duplicate secondary
    if (this._networks.primary === this._networks.secondary) {
      this._networks.secondary = 'none';
    }

    await this._parseProperties(this, '', skel.properties, defs);
    if (skel.secondary) {
      const defssecondary = defs.secondary || [];
      this._secondary = await Promise.all(skel.secondary.map(async (secondary, idx) => {
        const secondaryApp = {
          _image: secondary.image,
          _args: (secondary.properties.find(prop => prop.type === 'Arguments') || {}).defaultValue,
          _backups: [],
          _delay: secondary.delay || 0
        };
        await this._parseProperties(secondaryApp, `${idx}`, secondary.properties, defssecondary[idx] || {});
        return secondaryApp;
      }));
    }
    else {
      this._secondary = [];
    }
    this._skeleton = skel;
    this._monitor = skel.monitor || {};
    this._delay = skel.delay || 0;
    this._tags = (skel.tags || []).concat([ 'All' ]);

    return this;
  },

  _parseProperties: async function(target, ext, properties, defs) {
    target._env = {};
    target._features = {};
    target._ports = [];
    target._binds = [];
    target._files = [];
    const defsenv = defs.env || {};
    await Promise.all(properties.map(async prop => {
      switch (prop.type) {
        case 'Environment':
        {
          const found = defsenv[prop.name];
          if (found) {
            target._env[prop.name] = { value: found.value };
            if ('altValue' in found) {
              target._env[prop.name].altValue = found.altValue;
            }
          }
          else {
            target._env[prop.name] = { value: '' };
          }
          break;
        }
        case 'Directory':
        {
          let targetname = Path.normalize(prop.name);
          const description = prop.description || targetname;
          const bind = defs.binds && defs.binds.find(bind => bind.target === targetname);
          let src = null;
          if (prop.style !== 'temp') {
            if (bind && bind.src) {
              src = bind.src;
            }
            else if (prop.use) {
              const vbind = defs.binds && defs.binds.find(bind => bind.target === prop.use);
              if (vbind) {
                src = vbind.src;
              }
              else {
                // If we fail to find a binding, we create a default in 'store'. We don't use the properties
                // style to avoid errors where some prop.use have a style and some don't.
                src = Filesystem.getNativePath(this._id, 'store', `/vol/${prop.use}`);
              }
            }
            else if (targetname[0] !== '/') {
              src = Filesystem.getNativePath(this._id, prop.style, `/vol/${targetname}`);
              targetname = null;
            }
            else {
              src = Filesystem.getNativePath(this._id, prop.style, `/dir${ext}/${targetname}`);
            }
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
          f.data = file.data || prop.defaultValue || '';
          if (file.altData) {
            f.altData = file.altData;
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
          const port = {
            target: prop.name,
            port: prop.port,
            protocol: prop.protocol,
          };
          [ 'web', 'dns', 'nat', 'mdns' ].forEach(type => prop[type] && (port[type] = prop[type]));
          target._ports.push(port);
          break;
        }
        default:
          break;
      }
    }));
  },

  _updateIfBuiltin: async function() {
    const skel = Skeletons.loadSkeleton(this.skeletonId(), false);
    if (!skel || skel.type !== 'builtin') {
      return false;
    }
    const before = this.toJSON();
    await this.updateFromSkeleton(skel.skeleton, before);
    if (JSON.stringify(before) == JSON.stringify(this.toJSON())) {
      return false;
    }
    return true;
  },

  start: async function(inherit) {
    try {
      this._setStatus('starting');

      if (this._willCreateNetwork()) {
        Root.emit('net.create', { app: this });
      }

      // Make sure we have all the pieces
      await this.checkInstalled();

      this._bootcount++;

      inherit = inherit || {};

      this._fs = Filesystem.create(this);
      this._allmounts = await this._fs.getAllMounts(this);

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
      const pNetwork = this._networks.primary;
      const sNetwork = this._networks.secondary;
      if (pNetwork !== 'none') {
        switch (pNetwork) {
          case 'home':
            netEnv.DHCP_INTERFACE = 0;
            netEnv.NAT_INTERFACE = 0;
            netEnv.DEFAULT_INTERFACE = 0;
            break;
          case 'host':
            netEnv.DEFAULT_INTERFACE = 0;
            break;
          default:
            netEnv.NAT_INTERFACE = 0;
            netEnv.INTERNAL_INTERFACE = 0;
            netEnv.DEFAULT_INTERFACE = 0;
            break;
        }
        if (sNetwork !== 'none') {
          switch (sNetwork) {
            case 'home':
              netEnv.SECONDARY_INTERFACE = 1;
              netEnv.DHCP_INTERFACE = 1;
              netEnv.NAT_INTERFACE = 1;
              break;
            case 'dns':
              netEnv.SECONDARY_INTERFACE = 1;
              netEnv.DNS_INTERFACE = 1;
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

      switch (pNetwork) {
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
          config.HostConfig.DnsSearch = [ 'local' ];
          config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:2', 'attempts:1' ];
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
          const vpnapp = MinkeApp.getAppById(pNetwork);
          if (!vpnapp) {
            // VPN app isn't running - we can't startup.
            throw new Error('Cannot start application using network which isnt active');
          }
          const vpn = await Network.getPrivateNetwork(pNetwork);
          config.HostConfig.NetworkMode = vpn.id;
          configEnv.push(`__DNSSERVER=${vpnapp._secondaryIP}`);
          configEnv.push(`__GATEWAY=${vpnapp._secondaryIP}`);
          config.HostConfig.Dns = [ vpnapp._secondaryIP ];
          config.HostConfig.DnsSearch = [ 'local' ];
          config.HostConfig.DnsOptions = [ 'ndots:1', 'timeout:2', 'attempts:1' ];
          break;
        }
      }

      configEnv.push(`__GLOBALID=${this._globalId}`);

      if (this._features.tuntap) {
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

      if (pNetwork !== 'host') {

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
            DnsOptions: config.HostConfig.DnsOptions,
            Sysctls: {}
          },
          MacAddress: config.MacAddress,
          Env: [].concat(configEnv) // Helper doesn't get any of the application environment
        };
        helperConfig.Env.push(`__MINKENAME=${MinkeApp.getMinkeName() || 'minkebox'}`);

        if (pNetwork === 'home' || sNetwork === 'home') {
          const ip6 = this.getSLAACAddress();
          if (ip6) {
            helperConfig.Env.push(`__HOSTIP6=${ip6}`);
          }
        }

        if (this._willCreateNetwork()) {
          helperConfig.HostConfig.Sysctls["net.ipv4.ip_forward"] = "1";
        }

        // Expand the environment before selecting ports as this could effect their values
        this._fullEnv = await this._expandEnvironment(this._env, this._skeleton.properties);

        this._ddns = this._features.ddns || false;
        const nat = [];
        await Promise.all(this._ports.map(async port => {
          port = await this.expandPort(port);
          if (port.nat) {
            nat.push(`${port.port}:${port.protocol}`);
          }
        }));
        if (nat.length) {
          helperConfig.Env.push(`ENABLE_NAT=${nat.join(' ')}`);
          this._ddns = true;

          // If we're opening the NAT, and we're not on the home network, we need to find
          // the actual remote endpoint so we can create global network addresses.
          if ((netEnv.NAT_INTERFACE === 0 && pNetwork != 'home') ||
              (netEnv.NAT_INTERFACE === 1 && sNetwork != 'home')) {
            helperConfig.Env.push(`FETCH_REMOTE_IP=true`);
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
          try {
            await this._helperContainer.start();
          }
          catch (e) {
            console.error('Error starting helper');
            console.error(e);
            throw e;
          }

          // Attach new helper to secondary network if necessary
          if (pNetwork !== 'none') {
            switch (sNetwork) {
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
              case 'dns':
              {
                try {
                  const dnsnet = await Network.getDNSNetwork();
                  await dnsnet.connect({
                    Container: this._helperContainer.id
                  });
                }
                catch (e) {
                  console.error('Error connecting dns network');
                  console.error(e);
                }
                break;
              }
              default:
              {
                const vpn = await Network.getPrivateNetwork(sNetwork);
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
          DNS.registerHost(this._safeName(), `${this._globalId}${GLOBALDOMAIN}`, this._homeIP, homeip6);
        }

        // If we need to be accessed remotely, register with DDNS
        if (this._ddns) {
          DDNS.register(this);
        }

      }

      // Expand environment (again) after the helper has set some variables
      this._fullEnv = await this._expandEnvironment(this._env, this._skeleton.properties);

      config.Env = Object.keys(this._fullEnv).map(key => `${key}=${this._fullEnv[key].value}`).concat(configEnv);

      const ports = await Promise.all(this._ports.map(async port => await this.expandPort(port)));
      if (this._defaultIP) {
        const webport = ports.find(port => port.web);
        if (webport) {
          let web = webport.web;
          const urlip = `${webport.port === 443 ? 'https' : 'http'}://${this._defaultIP}${webport.port ? ':' + webport.port : ''}`;
          const url = web.url || `${webport.port === 443 ? 'https' : 'http'}://${this._homeIP}${webport.port ? ':' + webport.port : ''}`;
          switch (web.widget || 'none') {
            case 'newtab':
              if (this._homeIP) {
                this._widgetOpen = HTTP.createNewTab(this, `/a/w${this._id}`, web.path, url);
              }
              else {
                this._widgetOpen = HTTP.createNewTabProxy(this, `/a/w${this._id}`, web.path, urlip);
              }
              break;
            case 'inline':
              this._widgetOpen = HTTP.createProxy(this, `/a/w${this._id}`, web.path, urlip);
              break;
            case 'config':
              this._widgetOpen = HTTP.createUrl(`/configure/${this._id}/`);
              break;
            case 'none':
            default:
              this._widgetOpen = null;
              break;
          }
          switch (web.tab || 'none') {
            case 'newtab':
              if (this._homeIP) {
                this._tabOpen = HTTP.createNewTab(this, `/a/t${this._id}`, web.path, url);
              }
              else {
                this._tabOpen = HTTP.createNewTabProxy(this, `/a/t${this._id}`, web.path, urlip);
              }
              break;
            case 'inline':
              this._tabOpen = HTTP.createProxy(this, `/a/t${this._id}`, web.path, urlip);
              break;
            case 'none':
            default:
              this._tabOpen = null;
              break;
          }

          if (this._widgetOpen && this._widgetOpen.http) {
            koaApp.use(this._widgetOpen.http);
          }
          if (this._tabOpen && this._tabOpen.http) {
            koaApp.use(this._tabOpen.http);
          }
        }
      }

      if (this._homeIP) {
        const dnsport = ports.find(port => port.dns);
        if (dnsport) {
          this._dns = DNS.addDNSServer(this, { port: dnsport.port, dnsNetwork: sNetwork === 'dns' });
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

      // Setup timezone
      if (this._features.localtime) {
        config.HostConfig.Mounts.push({
          Type: 'bind',
          Source: '/usr/share/zoneinfo',
          Target: '/usr/share/zoneinfo',
          BindOptions: {
            Propagation: 'private'
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
            const secondaryMounts = await this._fs.getAllMounts(secondary);
            this._allmounts = this._allmounts.concat(secondaryMounts);
            const secondaryEnv = await this._expandEnvironment(secondary._env, this._skeleton.secondary[c].properties);
            const sconfig = {
              name: `${this._safeName()}__${this._id}__${c}`,
              Image: Images.withTag(secondary._image),
              Cmd: secondary._args,
              HostConfig: {
                Mounts: secondaryMounts,
                Devices: [],
                CapAdd: [],
                CapDrop: [],
                LogConfig: config.HostConfig.LogConfig,
                NetworkMode: `container:${this._helperContainer.id}`
              },
              Env: Object.keys(secondaryEnv).map(key => `${key}=${secondaryEnv[key].value}`)
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

    if (this._mdns) {
      await Promise.all(this._mdnsRecords.map(rec => MDNS.removeRecord(rec)));
      await Promise.all(this._netRecords.map(rec => MDNS.removeRecord(rec)));
      this._mdns = null;
      this._mdnsRecords = null;
    }

    if (this._dns) {
      DNS.removeDNSServer(this._dns);
      this._dns = null;
    }

    function removeMiddleware(m) {
      if (m.http) {
        const idx = koaApp.middleware.indexOf(m.http);
        if (idx !== -1) {
          koaApp.middleware.splice(idx, 1);
        }
      }
    }

    if (this._widgetOpen) {
      removeMiddleware(this._widgetOpen);
      this._widgetOpen = null;
    }
    if (this._tabOpen) {
      removeMiddleware(this._tabOpen);
      this._tabOpen = null;
    }
    if (this._webProxy) {
      this._webProxy.close();
      this._webProxy = null;
    }

    if (this._homeIP) {
      DNS.unregisterHost(this._safeName(), `${this._globalId}${GLOBALDOMAIN}`);
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
      await this._fs.unmountAll(this._allmounts);
    }
    this._fs = null;

    this._setStatus('stopped');

    if (this._willCreateNetwork()) {
      Root.emit('net.remove', { app: this });
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
      const old = this._setStatus('downloading');
      await Updater.updateApp(this);
      this._setStatus(old);
    }
  },

  uninstall: async function() {
    const idx = applications.indexOf(this);
    if (idx !== -1) {
      applications.splice(idx, 1);
    }
    // Can't delete during startup - so wait for that to be done
    while (this.isStarting()) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (this.isRunning()) {
      await this.stop();
    }

    // Create a new filesystem so we can uninstall. If the app wasn't running when we
    // uninstall then there was no file system available to use for this operation.
    Filesystem.create(this).uninstall();

    await Database.removeApp(this._id);

    Root.emit('app.remove', { app: this });
    if (this._willCreateNetwork()) {
      Root.emit('net.remove', { network: { _id: this._id, name: this._name } });
    }
  },

  getAvailableNetworks: function() {
    return MinkeApp.getNetworks();
  },

  getAvailableShareables: function() {
    const acc = [];
    applications.map(app => {
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
    });
    return acc;
  },

  getAvailableBackups: function() {
    const acc = [];
    applications.map(app => {
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
    });
    return acc;
  },

  getAvailableWebsites: async function(network) {
    const acc = [];
    await Promise.all(applications.map(async app => {
      if (app !== this && (network === app._networks.primary || network === app._networks.secondary)) {
        const ports = await Promise.all(app._ports.map(async port => await this.expandPort(port)));
        const webport = ports.find(port => port.web);
        if (webport && !webport.web.private) {
          acc.push({
            app: app,
            port: await this.expandPort(webport)
          });
        }
      }
    }));
    return acc;
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

  getWebLink: function(type) {
    switch (type) {
      case 'config':
      default:
        if (this._tabOpen || this._widgetOpen) {
          return {
            url: (this._tabOpen || this._widgetOpen).url,
            target: '_blank'
          };
        }
      case 'tab':
        if (this._tabOpen) {
          return {
            url: this._tabOpen.url,
            target: this._tabOpen.target
          };
        }
        break;
      case 'widget':
        if (this._widgetOpen) {
          return {
            url: this._widgetOpen.url,
            target: this._widgetOpen.target
          };
        }
        break;
    }
    return {};
  },

  getTimezone: function() {
    return setup ? setup.getTimezone() : 'UTC';
  },

  expand: async function(txt) {
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
        __HOSTNAME: { value: this._safeName() },
        __GLOBALNAME: { value: `${this._globalId}${GLOBALDOMAIN}` },
        __DOMAINNAME: { value: MinkeApp.getLocalDomainName() },

        __HOSTIP: { value: MinkeApp._network.network.ip_address },
        __HOMEIP: { value: this._homeIP || '<none>' },
        __HOMEIP6: { value: this.getSLAACAddress() || '<none>' },
        __HOMEADDRESSES: { value: addresses },
        __DNSSERVER: { value: MinkeApp._network.network.ip_address },
        __DEFAULTIP: { value: this._defaultIP || '<none>' },
        __SECONDARYIP: { value: this._secondaryIP || '<none>' },

        __IPV6ENABLED: { value : this.getSLAACAddress() ? 'true' : 'false' },
        __MACADDRESS: { value: this._primaryMacAddress().toUpperCase() }
      }, this._fullEnv);

      // Fetching random ports (while avoiding those in use on the NAT) can be time consuming so
      // only do this if we need to. We make sure 3 consequtive ports are available.
      if (txt.indexOf('{{__RANDOMPORT}}') !== -1) {
        env.__RANDOMPORT = { value: await this._allocateRandomNatPorts(3) };
      }

      // Generate random passwords of required length
      if (txt.indexOf('{{__SECUREPASSWORD') !== -1) {
        const match = txt.match(/{{__SECUREPASSWORD(\d+)}}/);
        if (match) {
          const len = parseInt(match[1]);
          env[`__SECUREPASSWORD${len}`] = { value: this._generateSecurePassword(len) };
        }
      }

      for (let key in env) {
        txt = txt.replace(new RegExp(`\{\{${key}\}\}`, 'g'), env[key].value);
      }
      // Support optional complex expression on strings
      if (txt.indexOf('{{EVAL ') === 0 && txt.indexOf('}}') === txt.length - 2) {
        try {
          txt = this._eval(txt.substring(7, txt.length -2));
        }
        catch (_) {
        }
      }
    }
    return txt;
  },

  expandPort: async function(port) {
    let web;
    if (typeof port.web === 'object' && port.web !== null) {
      web = {
        tab: port.web.tab || 'newtab',
        widget: port.web.widget || port.web.type
      };
      if (port.web.path) {
        web.path = await this.expand(port.web.path);
      }
      if (port.web.url) {
        web.url = await this.expand(port.web.url);
      }
      if (port.web.private) {
        web.private = true;
      }
    }
    else {
      web = null;
    }

    let dns;
    if (typeof port.dns === 'object') {
      dns = port.dns;
    }
    else if (typeof port.dns === 'string') {
      dns = await this._expandBool(port.dns);
    }
    else {
      dns = !!port.dns ? {} : null;
    }

    return {
      target: port.name || port.target,
      port: await this._expandNumber(port.port, port.defaultPort || 0),
      protocol: port.protocol,
      web: web,
      dns: dns,
      nat: await this._expandBool(port.nat || false),
      mdns: port.mdns || null
    };
  },

  _expandNumber: async function(val, alt) {
    if (typeof val === 'number') {
      return val;
    }
    if (typeof val === 'string') {
      try {
        val = this._eval(await this.expand(val));
        if (typeof val === 'number' && !isNaN(val)) {
          return val;
        }
      }
      catch (_) {
      }
    }
    return alt;
  },

  _expandBool: async function(val) {
    if (typeof val !== 'string') {
      return !!val;
    }
    try {
      val = this._eval(await this.expand(val));
      if (!val) {
        return false;
      }
    }
    catch (_) {
    }
    return true;
  },

  _expandEnvironment: async function(env, properties) {
    const fullEnv = {};
    let skelenv = null;
    for (let key in env) {
      const val = env[key].value;
      if (val) {
        fullEnv[key] = env[key];
      }
      else if (properties) {
        if (!skelenv) {
          skelenv = {};
          for (let i = 0; i < properties.length; i++) {
            const prop = properties[i];
            if (prop.type === 'Environment' && prop.defaultValue) {
              skelenv[prop.name] = await this.expand(prop.defaultValue);
            }
          }
        }
        fullEnv[key] = { value: skelenv[key] || '' };
      }
    }
    return fullEnv;
  },

  _eval: function(val) {
    const js = new JSInterpreter(val);
    for (let i = 0; i < JSINTERPRETER_STEPS && js.step(); i++)
      ;
    return js.value;
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
          idx = data.indexOf('MINKE:SECONDARY:IP ');
          if (idx !== -1) {
            this._secondaryIP = data.replace(/.*MINKE:SECONDARY:IP (.*)\n.*/, '$1');
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

  _createMonitor: function(args) {
    return Monitor.create({
      app: this,
      cmd: args.cmd,
      init: args.init
    });;
  },

  _setStatus: function(status) {
    const old = this._status;
    if (old !== status) {
      this._status = status;
      Root.emit('app.status.update', { app: this, status: status, oldStatus: old });
    }
    return old;
  },

  skeletonId: function() {
    return this._skeletonId || this._image;
  },

  isRunning: function() {
    return this._status === 'running';
  },

  isStarting: function() {
    return this._status === 'starting' || this._status === 'downloading';
  },

  _safeName: function() {
    return this._name.replace(/[^a-zA-Z0-9]/g, '');
  },

  _fullSafeName: function() {
    const domainname = MinkeApp.getLocalDomainName();
    return this._safeName() + (domainname ? '.' + domainname : '');
  },

  _primaryMacAddress: function() {
    const r = this._globalId.split('-')[4];
    return `${r[0]}a:${r[2]}${r[3]}:${r[4]}${r[5]}:${r[6]}${r[7]}:${r[8]}${r[9]}:${r[10]}${r[11]}`;
  },

  _willCreateNetwork: function() {
    return (this._networks.primary === this._id || this._networks.secondary === this._id);
  },

  _allocateRandomNatPorts: async function(count) {
    const minPort = 40000;
    const nrPorts= 1024;
    const active = await UPNP.getActivePorts();
    let port = Math.floor(Math.random() * nrPorts);
    for (;;) {
      let i;
      for (i = 0; i < count; i++) {
        if (active.indexOf(minPort + port + i) !== -1) {
          break;
        }
      }
      if (i === count) {
        break;
      }
      port = (port + count) % nrPorts;
    }
    return minPort + port;
  },

  _generateSecurePassword: function(len) {
    return Crypto.randomBytes(len / 2).toString('hex');
  }
}

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
    if (container.Image === Images.MINKE || container.Image === Images.withTag(Images.MINKE)) {
      MinkeApp._container = docker.getContainer(container.Id);
    }
  });

  // Setup the filesystem
  await Filesystem.init();

  // Get our IP
  MinkeApp._network = await Network.getActiveInterface();

  // Startup home network early (in background)
  Network.getHomeNetwork();

  // Startup the DNS network
  const dnsNet = await Network.getDNSNetwork();
  try {
    // Attach it if we don't have a system. If we do, then the dns network devices will exist in the container already.
    if (!SYSTEM) {
      await dnsNet.connect({
        Container: MinkeApp._container.id
      });
      // We have to put back the original default route. There really must be a better way ...
      ChildProcess.spawnSync('/sbin/ip', [ 'route', 'del', 'default' ]);
      ChildProcess.spawnSync('/sbin/ip', [ 'route', 'add', 'default', 'via', MinkeApp._network.network.gateway_ip ]);
    }
  }
  catch (e) {
    console.error('Failed to connect to DNS network');
    console.error(e);
  }

  // See if we have wifi (in background)
  Network.wifiAvailable();

  // Monitor docker events
  MinkeApp._monitorEvents();

  // Monitor host system
  System.start();

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
    LOCALDOMAIN: 'home',
    IP6: false,
    NATIP6: false,
    WIFIENABLED: false,
    DNSSERVER1: Config.DEFAULT_FALLBACK_RESOLVER,
    DNSSERVER2: '',
    TIMEZONE: Moment.tz.guess(),
    ADMINMODE: 'DISABLED',
    GLOBALID: UUID(),
    POSITION: 0,
    HUMAN: 'unknown'
  }, {
    HOSTNAME: 'MinkeBox',
    LOCALDOMAIN: '',
    DHCP: MinkeApp._network.dhcp,
    PORT: config.port || 80,
    IPADDRESS: MinkeApp._network.network.ip_address,
    GATEWAY: MinkeApp._network.network.gateway_ip,
    NETMASK: MinkeApp._network.netmask.mask,
    WIFINAME: '',
    WIFIPASSWORD: '',
    DNSSERVER1: '',
    DNSSERVER2: '',
    UPDATETIME: '03:00'
  });
  applications.unshift(setup);

  // Safe to start listening - only on the home network.
  const server = app.listen({
    host: MinkeApp._network.network.ip_address,
    port: config.port || 80
  });

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

    // If we want to inherit, make sure everything is still alive
    let alive = config.inherit;
    async function isAlive(container) {
      if (alive && container && !(await container.inspect()).State.Running) {
        alive = false;
      }
    }
    await isAlive(inherit.container);
    await isAlive(inherit.helperContainer);
    await Promise.all(inherit.secondary.map(async secondary => await isAlive(secondary)));

    // We need a helper unless we're using the host network
    if (app._networks.primary !== 'host' && !inherit.helperContainer) {
      alive = false;
    }

    // Make sure we have all the secondaries
    if (inherit.secondary.length !== app._secondary.length) {
      alive = false;
    }

    // Check if we need to update the app.
    if (await app._updateIfBuiltin()) {
      alive = false;
    }

    if (alive) {
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
    }
  }));

  await setup.start();

  // Make sure helper is installed
  try {
    await docker.getImage(Images.withTag(Images.MINKE_HELPER)).inspect();
  }
  catch (_) {
    await Pull.updateImage(Images.withTag(Images.MINKE_HELPER));
  }

  // Startup applications in order
  const order = MinkeApp.getStartupOrder();
  for (let i = 0; i < order.length; i++) {
    try {
      const app = order[i];
      if (app._status === 'stopped') {
        await app.start(inheritables[app._id]);
      }
    }
    catch (e) {
      console.error(e);
    }
  }
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
    none: true, host: true, home: true, dns: true
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
  if (list.length) {
    console.error(`Failed to order apps: ${list.map(app => app._name)}`);
  }

  return order;
}

MinkeApp.getAdvancedMode = function() {
  return setup ? setup.getAdvancedMode() : false;
}

MinkeApp.getLocalDomainName = function() {
  return setup ? setup.getLocalDomainName() : '';
}

MinkeApp.getMinkeName = function() {
  return setup ? setup._safeName() : '';
}

MinkeApp.shutdown = async function(config) {
  await Promise.all(applications.map(async (app) => {
    // If app is starting up, wait for it to finish ... then we can shut it down.
    // If the app is stopping, then no need to stop it again.
    while (app.isStarting()) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (app.isRunning()) {
      // If we shutdown with 'inherit' set, we leave the children running so we
      // can inherit them when on a restart. But we're always stopping Minke itself
      // so make sure we do that regardless.
      if (!config.inherit || app._image === Images.MINKE) {
        await app.stop();
      }
      await app.save();
    }
  }));
}

MinkeApp.create = async function(image) {
  const app = await new MinkeApp().createFromSkeleton((await Skeletons.loadSkeleton(image, true)).skeleton);
  applications.push(app);
  if (app._willCreateNetwork()) {
    Root.emit('net.create', { app: app });
  }
  await app.save();
  Root.emit('app.create', { app: app });

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

module.exports = MinkeApp;
