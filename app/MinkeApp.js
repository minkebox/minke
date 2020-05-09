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
const APP_MIGRATIONS = Config.APP_MIGRATIONS || {};

const CRASH_TIMEOUT = (2 * 60 * 1000); // 2 minutes
const HELPER_STARTUP_TIMEOUT = (30 * 1000); // 30 seconds
const JSINTERPRETER_STEPS = 100;
const JSINTERPRETER_EXPAND_ATTEMPTS = 10;

let applications = [];
let koaApp = null;
let setup = null;

function MinkeApp() {
}

MinkeApp.prototype = {

  createFromJSON: async function(app) {

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
    // MIGRATION - Keep May 15, 2020
    if (app.backups) {
      this._backups = app.backups;
    }
    if (app.vars) {
      this._vars = JSON.parse(app.vars);
    }
    // MIGRATION - Keep May 15, 2020
    // MIGRATION - Remove May 15, 2020
    if (typeof app.networks.primary === 'string') {
      this._networks = {
        primary: { name: app.networks.primary },
        secondary: { name: app.networks.secondary }
      };
    }
    else {
      this._networks = app.networks;
    }
    // MIGRATION - Remove May 15, 2020
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
        _files: secondary.files
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

    // MIGRATION - Remove May 15, 2020
    if (!this._vars) {
      this._vars = {};
      if (this._skeleton) {
        await this.updateVariables(this._skeleton, {});
        await this._variableMigration();
        await this.updateFromSkeleton(this._skeleton, this.toJSON());
        await this.save();
      }
    }
    // MIGRATION - Remove May 15, 2020

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
       // Cannot store raw key in DB due to '.' in keynames
      vars: JSON.stringify(Object.keys(this._vars).reduce((obj, key) => {
        obj[key] = Object.assign({}, this._vars[key]);
        if (this._vars[key].persist === false) {
          delete obj[key].value;
        }
        return obj;
      }, {})),
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
        };
      })
    }
  },

  updateVariables: async function(skeleton, cvars) {
    this._vars = {};
    for (let i = 0; i < skeleton.actions.length; i++) {
      const action = skeleton.actions[i];
      const ovalue = cvars[action.name] && cvars[action.name].value;
      switch (action.type) {
        case 'EditEnvironment':
          this._vars[action.name] = {
            type: 'String',
            value: ovalue || await this.expandString(action.initValue),
            defaultValue: action.defaultValue
          };
          break;
        case 'SetEnvironment':
          this._vars[action.name] = {
            type: 'String',
            value: ovalue || await this.expandString(action.initValue) || await this.expandString(action.value),
          };
          break;
        case 'EditEnvironmentAsCheckbox':
          this._vars[action.name] = {
            type: 'Bool',
            value: ovalue || await this.expandBool(action.initValue),
            defaultValue: action.defaultValue
          };
          break;
        case 'EditEnvironmentAsTable':
        case 'SelectWebsites':
        case 'EditFileAsTable':
          this._vars[action.name] = {
            type: 'Array',
            value: ovalue || (action.initValue && JSON.parse(await this.expandString(action.initValue)))
          };
          if (action.pattern) {
            this._vars[action.name].encoding = {
              pattern: action.pattern,
              join: 'join' in action ? action.join : '\n'
            };
          }
          break;
        case 'SelectBackups':
          this._vars[action.name] = {
            type: 'BackupSet',
            value: ovalue || []
          };
          break;
        case 'SelectDirectory':
        {
          this._vars[action.name] = {
            type: 'Path',
            value: ovalue || await this.expandPath(action.initValue)
          };
          break;
        }
        case 'SelectShares':
        {
          this._vars[action.name] = {
            type: 'PathSet',
            value: ovalue || []
          };
          break;
        }
        case 'EditFile':
          this._vars[action.name] = {
            type: 'String',
            value: ovalue || await this.expandString(action.initValue), // ovalue may be valid in some cases (restart)
            persist: false // Don't persist value in DB
          };
          break;
        case 'ShowFile':
        case 'DownloadFile':
          this._vars[action.name] = {
            type: 'String',
            value: undefined,
            persist: false // Don't persist value in DB
          };
          break;
        case 'ShowFileAsTable':
          this._vars[action.name] = {
            type: 'Array',
            value: undefined,
            persist: false // Don't persist value in DB
          };
          break;
        case 'EditShares':
        default:
          break;
      }
    }
    if (skeleton.constants) {
      for (let i = 0; i < skeleton.constants.length; i++) {
        const constant = skeleton.constants[i];
        this._vars[constant.name] = {
          type: `String`,
          value: null, // No value, which forces defaultValue to be expanded when used
          defaultValue: constant.value
        };
      }
    }
    //console.log('Created Vars', this._vars);
  },

  // MIGRATION - Remove May 15, 2020
  _variableMigration: async function() {
    for (let i = 0; i < this._skeleton.actions.length; i++) {
      const action = this._skeleton.actions[i];
      const env = this._env[action.name];
      switch (action.type) {
        case 'EditEnvironment':
          if (env && ('value' in env)) {
            this._vars[action.name].value = await this.expandString(env.value);
            this._env[action.name] = {};
          }
          break;
        case 'EditEnvironmentAsCheckbox':
          if (env && ('value' in env)) {
            this._vars[action.name].value = !!env.value;
            this._env[action.name] = {};
          }
          break;
        case 'EditEnvironmentAsTable':
        case 'SelectWebsites':
          if (env && env.altValue) {
            this._vars[action.name].value = JSON.parse(env.altValue);
            this._env[action.name] = {};
          }
          break;
        case 'EditFileAsTable':
        {
          const file = this._files.find(f => f.target === action.name);
          if (file && file.altData) {
            this._vars[action.name].value = JSON.parse(file.altData);
            delete file.altData;
          }
          break;
        }
        case 'SelectBackups':
          if (this._backups && this._backups.length) {
            this._vars[action.name].value = this._backups;
            delete this._backups;
          }
          break;
        case 'SelectDirectory':
        {
          const bind = this._binds && this._binds.find(bind => bind.target === action.name);
          if (bind && bind.src) {
            this._vars[action.name].value = bind.src;
          }
          break;
        }
        case 'SelectShares':
        {
          const bind = this._binds && this._binds.find(bind => bind.target === action.name);
          if (bind && bind.shares.length) {
            this._vars[action.name].value = bind.shares;
            bind.share = [];
          }
          break;
        }
        case 'EditFile':
        case 'ShowFile':
        case 'DownloadFile':
        case 'ShowFileAsTable':
        case 'EditShares':
        default:
          break;
      }
    }
  },
  // MIGRATION - Remove May 15, 2020

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
    this._globalId = UUID().toLowerCase();
    this._bootcount = 0;
    this._position = { tab: 0, widget: 0 };

    // Need JS available for configuration.
    await this.createJS();

    await this.updateFromSkeleton(skel, {});

    this._setStatus('stopped');

    return this;
  },

  updateFromSkeleton: async function(skel, defs) {

    this._skeleton = skel;
    this._skeletonId = skel.uuid;

    await this.updateVariables(skel, this._vars || {});

    this._description = skel.description;
    this._args = (skel.properties.find(prop => prop.type === 'Arguments') || {}).value;

    this._networks = {
      primary: { name: 'none' },
      secondary: { name: 'none' }
    };
    skel.properties.forEach(prop => {
      if (prop.type === 'Network') {
        if (prop.defaultValue === '__create' || prop.value === '__create') {
          this._networks[prop.name].name = this._id;
        }
        else if (defs.networks && defs.networks[prop.name]) {
          this._networks[prop.name] = defs.networks[prop.name];
        }
        else if (prop.value || prop.defaultValue) {
          this._networks[prop.name].name = prop.value || prop.defaultValue;
        }
        if (prop.bandwidth) {
          this._networks[prop.name].bandwidth = prop.bandwidth;
        }
      }
    });
    // Any created network must be secondary
    if (this._networks.primary.name === this._id) {
      this._networks.primary = this._networks.secondary;
      this._networks.secondary = { name: this._id };
    }
    // If we only have one network, must be primary
    if (this._networks.primary.name === 'none') {
      this._networks.primary = this._networks.secondary;
      this._networks.secondary = { name: 'none' };
    }

    await this._parseProperties(this, '', skel.properties, defs.binds || []);
    if (skel.secondary) {
      this._secondary = await Promise.all(skel.secondary.map(async (secondary, idx) => {
        const secondaryApp = {
          _image: secondary.image,
          _args: (secondary.properties.find(prop => prop.type === 'Arguments') || {}).value,
          _delay: secondary.delay || 0
        };
        await this._parseProperties(secondaryApp, `${idx}`, secondary.properties, []);
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

  _parseProperties: async function(target, ext, properties, oldbinds) {
    target._env = {};
    target._features = {};
    target._ports = [];
    target._binds = [];
    target._files = [];
    await Promise.all(properties.map(async prop => {
      switch (prop.type) {
        case 'Environment':
        {
          target._env[prop.name] = {};
          let value;
          if ('value' in prop) {
            value = prop.value;
          }
          else if ('defaultValue' in prop) {
            value = prop.defaultValue;
          }
          if (value !== null && value !== undefined) {
            target._env[prop.name].value = this._expressionString2JS(value.toString());
          }
          break;
        }
        case 'Directory':
        {
          let src = null;
          if (prop.use) {
            src = Filesystem.getNativePath(this._id, 'store', `/vol/${prop.use}`);
          }
          else {
            src = Filesystem.getNativePath(this._id, prop.style, `/dir${ext}/${prop.name}`);
          }
          let shares = prop.shares || [];
          if (shares.length === 0) {
            const bind = oldbinds.find(p => p.target === prop.name);
            if (bind && bind.shares) {
              shares = bind.shares;
            }
          }
          target._binds.push({
            dir: prop.use || prop.name,
            src: src,
            target: prop.name,
            description: prop.description || prop.name,
            backup: prop.backup,
            shares: shares
          });
          break;
        }
        case 'File':
        {
          const targetname = Path.normalize(prop.name);
          target._files.push({
            src: Filesystem.getNativePath(this._id, prop.style, `/file${ext}/${prop.name.replace(/\//g, '_')}`),
            target: targetname,
            mode: prop.mode || 0o666,
            backup: prop.backup,
            value: prop.value || prop.defaultValue
          });
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
    const cid = this.skeletonId();
    const sid = APP_MIGRATIONS[cid] || cid;
    const skel = Skeletons.loadSkeleton(sid, false);
    if (!skel) {
      return false;
    }
    // If we're migrating the app to another skeleton, we update and restart it regardless
    if (cid !== sid) {
      console.log(`Migrating app from ${cid} to ${sid}`);
      await this.updateFromSkeleton(skel.skeleton, this.toJSON());
    }
    else {
      if (!skel || skel.type !== 'builtin') {
        return false;
      }
      const before = this.toJSON();
      await this.updateFromSkeleton(skel.skeleton, before);
      if (JSON.stringify(before) == JSON.stringify(this.toJSON())) {
        return false;
      }
    }
    await this.save();
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

      // Create new JS instance which will be used to evaluation app configuration
      await this.createJS();

      this._bootcount++;

      inherit = inherit || {};

      this._fs = Filesystem.create(this);
      this._mounts = await this._fs.getAllMounts(this);

      const config = {
        name: `${this._safeName()}__${this._id}`,
        Hostname: this._safeName(),
        Image: Images.withTag(this._image),
        Cmd: this._args,
        HostConfig: {
          Mounts: this._mounts,
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
      const pNetwork = this._networks.primary.name;
      // Remove secondary network during app creation. Some apps might have to option of using one or two networks.
      const sNetwork = this._networks.secondary.name !== pNetwork ? this._networks.secondary.name : 'none';
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
          if (sNetwork === 'home') {
            configEnv.push(`__HOSTIP=${MinkeApp._network.network.ip_address}`);
            configEnv.push(`__DOMAINNAME=${MinkeApp.getLocalDomainName()}`);
          }
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

      const extraHosts = [];
      function extractHost(cf) {
        const img = Images.withTag(cf._image).split(/[/:]/);
        extraHosts.push(`${img[img.length - 2]}:127.0.0.1`);
      }
      this._secondary.forEach(extractHost);
      config.HostConfig.ExtraHosts = extraHosts;

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

        // Network shaping
        // Note. We store values in Mbps, but the wondershaper in the helper takes kbps.
        if (this._networks.primary.bandwidth) {
          helperConfig.Env.push(`__DEFAULT_INTERFACE_BANDWIDTH=${1024 * await this.expandNumber(this._networks.primary.bandwidth)}`);
        }
        if (this._networks.secondary.bandwidth) {
          helperConfig.Env.push(`__SECONDARY_INTERFACE_BANDWIDTH=${1024 * await this.expandNumber(this._networks.secondary.bandwidth)}`);
        }

        // Expand the environment before selecting ports as this could effect their values
        this._fullEnv = await this.expandEnvironment(this._env, this._skeleton.properties);

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
          // If we need to be accessed remotely, register with DDNS
          if (this._ddns) {
            DDNS.register(this);
          }
        }
        else if (this._defaultIP) {
          DNS.registerHost(this._safeName(), null, this._defaultIP, null);
        }

      }

      // Expand environment (again) after the helper has set some variables
      this._fullEnv = await this.expandEnvironment(this._env, this._skeleton.properties);

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

        //console.log('primary', config);
        this._container = await docker.createContainer(config);
        startup.push({ delay: this._delay, container: this._container });

        // Setup secondary containers
        if (this._secondary.length) {
          this._secondaryContainers = [];
          for (let c = 0; c < this._secondary.length; c++) {
            const secondary = this._secondary[c];
            secondary._mounts = await this._fs.getAllMounts(secondary);
            const secondaryEnv = await this.expandEnvironment(secondary._env, this._skeleton.secondary[c].properties);
            const sconfig = {
              name: `${this._safeName()}__${this._id}__${c}`,
              Image: Images.withTag(secondary._image),
              Cmd: secondary._args,
              HostConfig: {
                Mounts: secondary._mounts,
                Devices: [],
                CapAdd: [],
                CapDrop: [],
                LogConfig: config.HostConfig.LogConfig,
                NetworkMode: `container:${this._helperContainer.id}`
              },
              Env: Object.keys(secondaryEnv).map(key => `${key}=${secondaryEnv[key].value}`)
            };
            //console.log(`secondary${c}`, sconfig);
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

    DNS.unregisterHost(this._safeName());
    if (this._homeIP) {
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

    if (this._fs) {
      await this._fs.unmountAll(this, this._mounts);
      for (let i = 0; i < this._secondary.length; i++) {
        await this._fs.unmountAll(this._secondary[i], this._secondary[i]._mounts);
      }
      this._fs = null;
    }

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
    // Force skeleton update on explicity restart
    const skel = Skeletons.loadSkeleton(this.skeletonId(), false);
    if (skel) {
      await this.updateFromSkeleton(skel.skeleton, this.toJSON());
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
      if (app !== this && (network === app._networks.primary.name || network === app._networks.secondary.name)) {
        const ports = await Promise.all(app._ports.map(async port => await app.expandPort(port)));
        const webport = ports.find(port => port.web);
        if (webport && !webport.web.private) {
          acc.push({
            app: app,
            port: webport
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

  expandString: async function(txt, extras) {
    if (!txt) {
      return txt;
    }
    txt = String(txt);
    // Simple strings
    if (txt.indexOf('{{') === -1) {
      return txt;
    }
    // Convert to evaluatable form and eval
    else {
      try {
        txt = await this._eval(this._expressionString2JS(txt), extras);
      }
      catch (e) {
        console.log(e);
      }
    }
    return txt;
  },

  _expressionString2JS: function(str) {
    const p = str.replace(/\n/g, '\\n').split(/({{|}})/);
    let js = '';
    let expr = false;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === '{{') {
        js += `+(`;
        expr = true;
      }
      else if (p[i] === '}}') {
        js += `)+`;
        expr = false;
      }
      else if (expr) {
        js += p[i];
      }
      else {
        js += `"${p[i].replace(/"/g, '\\"')}"`;
      }
    }
    return js;
  },

  expandPath: async function(path) {
    const v = this._vars[path];
    if (v && v.type === 'Path') {
      return v.value;
    }
    return path;
  },

  expandPathSet: async function(path) {
    const v = this._vars[path];
    if (v && v.type === 'PathSet') {
      return v.value;
    }
    return [];
  },

  expandBackupSet: async function(path) {
    const v = this._vars[path];
    if (v && v.type === 'BackupSet') {
      return v.value;
    }
    return [];
  },

  expandPort: async function(port) {
    let web;
    if (typeof port.web === 'object' && port.web !== null) {
      web = {
        tab: port.web.tab || 'newtab',
        widget: port.web.widget || port.web.type
      };
      if (port.web.path) {
        web.path = await this.expandPath(port.web.path);
      }
      if (port.web.url) {
        web.url = await this.expandString(port.web.url);
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
      dns = await this.expandBool(port.dns);
    }
    else {
      dns = !!port.dns ? {} : null;
    }

    const nport = {
      target: port.name || port.target,
      port: await this.expandNumber(port.port, port.defaultPort || 0),
      protocol: port.protocol,
      web: web,
      dns: dns,
      nat: await this.expandBool(port.nat || false),
      mdns: port.mdns || null
    };
    //console.log(port, nport);
    return nport;
  },

  expandNumber: async function(val, alt) {
    if (typeof val === 'number') {
      return val;
    }
    if (typeof val === 'string') {
      try {
        val = await this._eval(val.replace(/({{|}})/g, ''));
        const nval = Number(val);
        if (val == nval) {
          return nval;
        }
      }
      catch (_) {
      }
    }
    return alt;
  },

  expandBool: async function(val) {
    if (typeof val !== 'string') {
      return !!val;
    }
    try {
      val = await this._eval(val.replace(/({{|}})/g, ''));
      if (!val) {
        return false;
      }
    }
    catch (_) {
    }
    return true;
  },

  setVariable: function(name, value) {
    const v = this._vars[name];
    if (v && v !== value) {
      switch (v.type) {
        case 'Array':
          if (JSON.stringify(v.value) !== value) {
            v.value = JSON.parse(value);
            return true;
          }
          break;
        case 'PathSet':
          if (JSON.stringify(v.value) !== JSON.stringify(value)) {
            v.value = value;
            return true;
          }
          break;
        default:
          v.value = value;
          return true;
      }
    }
    return false;
  },

  expandVariable: async function(name) {
    const v = this._vars[name];
    if (!v) {
      return null;
    }
    let value = v.value;
    if ((value === undefined || value === null || value === '') && v.defaultValue) {
      value = await this.expandString(v.defaultValue);
    }
    switch (v.type) {
      case 'String':
      case 'Bool':
        // Reduce values to Booleans or Numbers if possible
        if (String(value).toLowerCase() === 'true') {
          value = true;
        }
        else if (String(value).toLowerCase() === 'false') {
          value = false;
        }
        else if (Number(value) == value) {
          value = Number(value);
        }
        return value;
      case 'Path':
      {
        return value === undefined || value === null ? value : String(value);
      }
      case 'Array':
      {
        const encoding = v.encoding || { pattern: '{{V[0]}}', join: '\n' };
        const value = v.value || [];
        const nvalue = [];
        for (let r = 0; r < value.length; r++) {
          const V = [];
          for (let i = 0; i < value[r].length; i++) {
            let entry = value[r][i];
            if (String(entry).toLowerCase() === 'true') {
              entry = true;
            }
            else if (String(entry).toLowerCase() === 'false') {
              entry = false;
            }
            else if (Number(entry) == entry) {
              entry = Number(entry);
            }
            V[i] = entry;
          }
          nvalue.push(await this.expandString(encoding.pattern, { V: V }));
        }
        return nvalue.join(encoding.join);
      }
      case 'PathSet':
      {
        const encoding = v.encoding || { join: '\n' };
        return v.value.join(encoding.join);
      }
      default:
        return ''
    }
  },

  isVariableConstant: function(name) {
    const v = this._vars[name];
    if (v && v.value && v.type !== 'Array') {
      return true;
    }
    return false;
  },

  expandEnvironment: async function(env) {
    const fullEnv = {};
    // Evaluate the environment
    for (let key in env) {
      let value = null;
      if (env[key] && env[key].value) {
        value = await this._eval(env[key].value);
      }
      else if (this._vars[key]) {
        value = await this.expandVariable(key, {});
      }
      if (value === undefined || value === null) {
        fullEnv[key] = { value: '' };
      }
      else {
        fullEnv[key] = { value: value };
      }
    }
    //console.log('expandEnv', env, '->', fullEnv);
    return fullEnv;
  },

  _eval: async function(code, extras) {
    try {
      const result = await this.execJS(code, extras);
      //console.log('eval', code, result);
      return result;
    }
    catch (e) {
      console.error('eval fail', code, this._vars);
      throw e;
    }
  },

  createJS: async function() {
    //console.log(`Creating JS for ${this._name}`);
    // Create new interpreter
    const js = new JSInterpreter('');
    this._js = js;
    const glb = this._js.globalObject;

    const asyncWrap = (fn) => {
      return js.createAsyncFunction(async (a,b,c,d,e,f,g,h,i, callback) => {
        let result = null;
        js._inAsyncFn = true;
        try {
          result = await fn(a,b,c,d,e,f,g,h,i);
        }
        catch (_) {
        }
        js._inAsyncFn = false;
        callback(result);
      });
    };

    // Set various app values
    js.setProperty(glb, '__GLOBALNAME', `${this._globalId}${GLOBALDOMAIN}`);
    js.setProperty(glb, '__DOMAINNAME', MinkeApp.getLocalDomainName());
    js.setProperty(glb, '__HOSTIP', MinkeApp._network.network.ip_address);
    js.setProperty(glb, '__HOMEIP', this._homeIP);
    js.setProperty(glb, '__HOMEIP6', this.getSLAACAddress() || '');
    js.setProperty(glb, '__DNSSERVER',  MinkeApp._network.network.ip_address);
    js.setProperty(glb, '__MACADDRESS', this._primaryMacAddress().toUpperCase());
    js.setProperty(glb, '__HOMEADDRESSES', this._homeIP); // MIGRATION - Remove May 15, 2020
    js.setProperty(glb, '__IPV6ENABLED', !!this.getSLAACAddress()); // MIGRATION - Remove May 15, 2020
    // And app functions
    js.setProperty(glb, '__RANDOMHEX', js.createNativeFunction(len => {
      return this._generateSecurePassword(len);
    }));
    js.setProperty(glb, '__RANDOMPORTS', asyncWrap(async nr => {
      return await this._allocateRandomNatPorts(nr);
    }));
    js.setProperty(glb, '__LOOKUPIP', js.createNativeFunction(host => {
      return DNS.lookupLocalnameIP(host);
    }));

    // Start by setting properties for all constant variables. These are the ones which
    // don't require the interpreter to be evaluated.
    const undef = '<<UNDEFINED>>';
    const todo = {};
    for (let name in this._vars) {
      if (this.isVariableConstant(name)) {
        this._js.setProperty(glb, name, await this.expandVariable(name));
      }
      else {
        this._js.setProperty(glb, name, undef);
        todo[name] = undef;
      }
    }
    // Now we evaluate non-constants until nothing changes
    for (let attempts = JSINTERPRETER_EXPAND_ATTEMPTS; attempts > 0 && Object.keys(todo).length; attempts--) {
      for (let name in todo) {
        const value = await this.expandVariable(name);
        if (value !== todo[name]) {
          this._js.setProperty(glb, name, value);
          todo[name] = value;
        }
        if (String(value).indexOf(undef) === -1) {
          delete todo[name];
        }
      }
    }
    if (Object.keys(todo).length) {
      console.log('Variable evalulation failed for: ' + Object.keys(todo).join(' '));
    }


    // Add current variables. Evaluating variables may, in turn, result in calls to
    // the interpreter (which is why we setup initial values).
    /*for (let name in this._vars) {
      this._js.setProperty(glb, name, await this.expandVariable(name));
    }*/

    return this._js;
  },

  updateJSProperty: function(name, value) {
    this._js.setProperty(this._js.globalObject, name, this._js.nativeToPseudo(value));
  },

  execJS: async function(code, extras) {
    const js = this._js;
    if (!js) {
      throw new Error('Missing interpreter');
    }
    try {
      if (extras) {
        js.setProperty(js.globalObject, '__extras', js.nativeToPseudo(extras));
        code = `with(__extras){${code}}`;
      }
      js.appendCode(code);
      let i;
      for (i = 0; i < JSINTERPRETER_STEPS && (js.step() || js._inAsyncFn); i++) {
        if (js._inAsyncFn) {
          await new Promise(done => setTimeout(done, 10));
        }
      }
      if (i >= JSINTERPRETER_STEPS) {
        throw new Error('Interpreter overrun');
      }
    }
    finally {
      if (extras) {
        delete js.globalObject.properties.__extras;
      }
    }
    return js.pseudoToNative(js.value);
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
            this.updateJSProperty('__HOMEIP', this._homeIP);
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
      target: args.target,
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
    return (this._networks.primary.name === this._id || this._networks.secondary.name === this._id);
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
    console.error('Failed to connect to DNS network - ignoring');
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
  applications = await Promise.all((await Database.getApps()).map(async json => {
    return await (new MinkeApp().createFromJSON(json));
  }));

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
    GLOBALID: UUID().toLowerCase(),
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
    if (app._networks.primary.name !== 'host' && !inherit.helperContainer) {
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
    if (list[i]._networks.primary.name === 'host' && list[i]._networks.secondary.name === 'none') {
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
      if ((networks[app._networks.primary.name] || app._networks.primary.name === app._id) &&
          (networks[app._networks.secondary.name] || app._networks.secondary.name === app._id)) {
        networks[app._networks.primary.name] = true;
        networks[app._networks.secondary.name] = true;
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
      if (!config.inherit || app._image === Images.MINKE || app._image === Images.withTag(Images.MINKE)) {
        await app.stop();
      }
      await app.save();
    }
  }));
}

MinkeApp.create = async function(image) {
  const app = await new MinkeApp().createFromSkeleton((await Skeletons.loadSkeleton(image, true)).skeleton);
  applications.push(app);
  await app.save();

  if (app._willCreateNetwork()) {
    Root.emit('net.create', { app: app });
  }
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
