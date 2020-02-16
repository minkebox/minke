const FS = require('fs');
const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const Images = require('./Images');
const DNS = require('./DNS');
const Network = require('./Network');
const Database = require('./Database');
const MDNS = require('./MDNS');
const UPNP = require('./UPNP');
const MinkeApp = require('./MinkeApp');
const Updater = require('./Updater');
const DDNS = require('./DDNS');
const Disks = require('./Disks');

const RESTART_REASON = '/tmp/minke-restart-reason';


function MinkeSetup(savedConfig, config) {

  EventEmitter.call(this);

  savedConfig = savedConfig || {};

  function getEnv(name) {
    return { value: savedConfig[name] || config[name] };
  }

  this._id = 'minke';
  this._image = Images.MINKE;
  this._status = 'running';
  this._features = {};
  this._binds = [];
  this._files = [{
    src: '/minke/minkebox.config',
    target: '/minkebox.config',
    data: '',
    mode: 0o600,
    backup: true
  }];
  this._customshares = [];
  this._secondary = [];
  this._ports = [
    { port: getEnv('PORT').value, protocol: 'TCP', mdns: { type: '_minkebox._tcp' } },
    { port: getEnv('PORT').value + 1, protocol: 'TCP', mdns: { type: '_ssh._tcp' } }
  ];
  this._networks = {
    primary: getEnv('REMOTEMANAGEMENT').value || 'none',
    secondary: 'host'
  };
  this._monitor = {};
  this._env = {
    LOCALDOMAIN: getEnv('LOCALDOMAIN'),
    DHCP: getEnv('DHCP'),
    PORT: getEnv('PORT'),
    IPADDRESS: getEnv('IPADDRESS'),
    NETMASK: getEnv('NETMASK'),
    GATEWAY: getEnv('GATEWAY'),
    IP6: getEnv('IP6'),
    NATIP6: getEnv('NATIP6'),
    WIFIENABLED: getEnv('WIFIENABLED'),
    WIFINAME: getEnv('WIFINAME'),
    WIFIPASSWORD: getEnv('WIFIPASSWORD'),
    DNSSERVER1: getEnv('DNSSERVER1'),
    DNSSERVER2: getEnv('DNSSERVER2'),
    DNSSECURE1: getEnv('DNSSECURE1'),
    DNSSECURE2: getEnv('DNSSECURE2'),
    TIMEZONE: getEnv('TIMEZONE'),
    ADMINMODE: getEnv('ADMINMODE'),
    GLOBALID: getEnv('GLOBALID'),
    UPDATETIME: getEnv('UPDATETIME'),
    DISKS: getEnv('DISKS')
  };
  this._name = getEnv('HOSTNAME').value;
  this._homeIP = this._env.IPADDRESS.value;
  this._privateIP = this._homeIP;
  this._globalId = this._env.GLOBALID.value;
  this._tags = [ 'All' ];
}

MinkeSetup.prototype = {

  start: async function() {

    await this._setupDisks();

    this._setTimezone();
    this._setUpdateTime();

    DNS.start({
      hostname: this._name,
      domainname: this.getLocalDomainName(),
      ip: this._env.IPADDRESS.value,
      resolvers: [ this._env.DNSSERVER1.value, this._env.DNSSERVER2.value ],
      secure: [ this._env.DNSSECURE1.value, this._env.DNSSECURE2.value ]
    });
    DDNS.start(this._globalId);
    await UPNP.start({
      uuid: this._globalId,
      hostname: this._name,
      ipaddress: this._env.IPADDRESS.value,
      port: this._env.PORT.value
    });
    await MDNS.start({
      ipaddress: this._env.IPADDRESS.value
    });

    this._hostMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._env.IPADDRESS.value,
      service: '_http._tcp',
      port: this._env.PORT.value,
      txt: []
    });
    this._minkeMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._env.IPADDRESS.value,
      service: '_minkebox._tcp',
      port: this._env.PORT.value,
      txt: []
    });
    this._sshdMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._env.IPADDRESS.value,
      service: '_ssh._tcp',
      port: this._env.PORT.value + 1,
      txt: []
    });
  },

  stop: async function() {
    this._status = 'shutting down';
    this.emit('update.status', { app: this, status: this._status });
    await MDNS.stop();
    await UPNP.stop();
    await DNS.stop();
  },

  restart: async function(reason) {
    await MDNS.removeRecord(this._hostMdns);
    this._hostMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._env.IPADDRESS.value,
      service: '_http._tcp',
      port: this._env.PORT.value,
      txt: []
    });
    await MDNS.removeRecord(this._minkeMdns);
    this._minkeMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._env.IPADDRESS.value,
      service: '_minkebox._tcp',
      port: this._env.PORT.value,
      txt: []
    });
    await MDNS.removeRecord(this._sshdMdns);
    this._sshdMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._env.IPADDRESS.value,
      service: '_ssh._tcp',
      port: this._env.PORT.value + 1,
      txt: []
    });
    UPNP.update({ hostname: this._name });
    DNS.setHostname(this._name);
    DNS.setDefaultResolver(
      this._env.DNSSERVER1.value,
      this._env.DNSSERVER2.value,
      this._env.DNSSECURE1.value,
      this._env.DNSSECURE2.value
    );
    DNS.setDomainName(this.getLocalDomainName());
    Network.setHomeNetwork({
      enable: !this._env.WIFIENABLED.value,
      address: this._env.DHCP.value ? 'dhcp' : this._env.IPADDRESS.value,
      netmask: this._env.NETMASK.value,
      gateway: this._env.GATEWAY.value
    });
    Network.setWiredNetwork({
      enable: !this._env.WIFIENABLED.value,
    });
    Network.setWiFiNetwork({
      enable: this._env.WIFIENABLED.value,
      network: this._env.WIFINAME.value,
      password: this._env.WIFIPASSWORD.value,
      address: this._env.DHCP.value ? 'dhcp' : this._env.IPADDRESS.value,
      netmask: this._env.NETMASK.value,
      gateway: this._env.GATEWAY.value
    });
    if (this._networks.primary !== 'none') {
      const app = MinkeApp.getAppById(this._networks.primary);
      if (app) {
        app._needRestart = true;
      }
    }
    this._setTimezone();
    this._setUpdateTime();
    await this.save();
    this.emit('update.status', { app: this, status: this._status });
    if (reason) {
      this.systemRestart(reason);
    }
  },

  save: async function() {
    const config = {
      LOCALDOMAIN: null,
      IP6: null,
      NATIP6: null,
      WIFIENABLED: null,
      WIFINAME: null,
      WIFIPASSWORD: null,
      DNSSERVER1: null,
      DNSSERVER2: null,
      DNSSECURE1: null,
      DNSSECURE2: null,
      ADMINMODE: null,
      GLOBALID: null,
      UPDATETIME: null,
      DISKS: null
    };
    for (let key in config) {
      config[key] = this._env[key].value;
    }
    config.HOSTNAME = this._name;
    config.REMOTEMANAGEMENT = this._networks.primary;
    config.DISKS = Disks.getMappedDisks();
    config._id = this._id;
    await Database.saveConfig(config);
  },

  getAvailableNetworks: function() {
    return MinkeApp.getApps().reduce((acc, app) => {
      if (app._image === Images.withTag(Images.MINKE_PRIVATE_NETWORK)) {
        acc.push({ _id: app._id, name: app._name });
      }
      return acc;
    }, []);
  },

  getWebLink: function() {
    return {};
  },

  _safeName: function() {
    return this._name;
  },

  _willCreateNetwork: function() {
    return false;
  },

  getAdvancedMode: function() {
    return this._env.ADMINMODE.value === 'ENABLED';
  },

  getLocalDomainName: function() {
    return this._env.LOCALDOMAIN.value;
  },

  getIP6: function() {
    if (!Network.getSLAACAddress()) {
      return false;
    }
    else {
      return !!this._env.IP6.value;
    }
  },

  getNATIP6: function() {
    return this.getIP6() && !!this._env.NATIP6.value;
  },

  isRunning: function() {
    return true;
  },

  expand: function(txt) {
    if (typeof txt ==='string' && txt.indexOf('{{') !== -1) {
      const env = Object.assign({
        __DOH: { value: DNS.getSDNS() || '<none>' }
      }, this._env);
      for (let key in env) {
        txt = txt.replace(new RegExp(`\{\{${key}\}\}`, 'g'), env[key].value);
      }
    }
    return txt;
  },

  _setupDisks: async function() {
    await Disks.init(this._env.DISKS.value);
  },

  _setTimezone: function() {
    if (DEBUG) {
      return false;
    }
    try {
      const timezone = this._env.TIMEZONE.value;
      const oldtimezone = FS.readFileSync('/etc/timezone', { encoding: 'utf8' });
      const zonefile = `/usr/share/zoneinfo/${timezone}`;
      if (oldtimezone != timezone && FS.existsSync(zonefile)) {
        FS.copyFileSync(zonefile, '/etc/localtime');
        FS.writeFileSync('/etc/timezone', timezone);
        return true;
      }
    }
    catch (_) {
    }
    return false;
  },

  _setUpdateTime: function() {
    try {
      const time = this._env.UPDATETIME.value.split(':')
      const config = {
        hour: parseInt(time[0]),
        minute: parseInt(time[1])
      };
      if (config.hour >= 0 && config.hour <= 23 && config.minute >= 0 && config.minute <= 59) {
        Updater.restart(config);
      }
    }
    catch (_) {
    }
  },

  systemRestart: async function(reason) {
    FS.writeFileSync(RESTART_REASON, reason);
    switch (reason) {
      case 'restart':
      case 'update':
      case 'update-native':
        await MinkeApp.shutdown({ inherit: true });
        process.exit();
        break;

      case 'restore':
        process.exit();
        break;

      case 'reboot':
      case 'halt':
      default:
        await MinkeApp.shutdown({});
        process.exit();
        break;
    }
  }

}

Util.inherits(MinkeSetup, EventEmitter);

module.exports = MinkeSetup;
