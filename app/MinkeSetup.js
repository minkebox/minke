const FS = require('fs');
const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const ChildProcess = require('child_process');
const Images = require('./Images');
const DNSForward = require('./DNSForward');
const Network = require('./Network');
const Database = require('./Database');
const MDNS = require('./MDNS');
const UPNP = require('./UPNP');

const RESTART = '/sbin/reboot';
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
  this._customshares = [];
  this._ports = [];
  this._networks = {
    primary: 'host'
  };
  this._monitor = {};
  this._env = {
    LOCALDOMAIN: getEnv('LOCALDOMAIN'),
    DHCP: getEnv('DHCP'),
    IPADDRESS: getEnv('IPADDRESS'),
    NETMASK: getEnv('NETMASK'),
    GATEWAY: getEnv('GATEWAY'),
    DNSSERVER1: getEnv('DNSSERVER1'),
    DNSSERVER2 : getEnv('DNSSERVER2'),
    TIMEZONE: getEnv('TIMEZONE'),
    ADMINMODE: getEnv('ADMINMODE'),
    GLOBALID: getEnv('GLOBALID')
  };
  this._name = getEnv('HOSTNAME').value;
  this._homeIP = this._env.IPADDRESS.value;

  this._setupTimezone();
  this._setupDNS();
  this._setupMDNS();
  this._setupUPNP();
}

MinkeSetup.prototype = {

  start: async function() {
  },

  stop: async function() {
    this._status = 'shutting down';
    this.emit('update.status', { app: this, status: this._status });
    await MDNS.stop();
    await UPNP.stop();
  },

  restart: async function(reason) {
    this._setupHomeNetwork();
    this._setupDNS();
    this._setupTimezone();
    this.save();
    this.emit('update.status', { app: this, status: this._status });
    if (reason) {
      this._restart(reason);
    }
  },

  save: async function() {
    const config = {
      LOCALDOMAIN: null,
      DNSSERVER1: null,
      DNSSERVER2: null,
      ADMINMODE: null,
      GLOBALID: null
    };
    for (let key in config) {
      config[key] = this._env[key].value;
    }
    config.HOSTNAME = this._name;
    config._id = this._id;
    await Database.saveConfig(config);
  },

  getAvailableNetworks: function() {
    return [];
  },

  _safeName: function() {
    return this._name;
  },

  _willCreateNetwork: function() {
    return false;
  },

  getAdminMode: function() {
    return this._env.ADMINMODE.value === 'ENABLED';
  },

  getLocalDomainName: function() {
    return this._env.LOCALDOMAIN.value;
  },

  _setupHomeNetwork: function() {
    return Network.setHomeNetwork({
      address: this._env.DHCP ? 'dhcp' : this._env.IPADDRESS.value,
      netmask: this._env.NETMASK.value,
      gateway: this._env.GATEWAY.value
    });
  },

  _setupTimezone: function() {
    if (DEBUG) {
      return false;
    }
    const timezone = this._env.TIMEZONE.value;
    const oldtimezone = FS.readFileSync('/etc/timezone').toString('utf8');
    const zonefile = `/usr/share/zoneinfo/${timezone}`;
    if (oldtimezone != timezone && FS.existsSync(zonefile)) {
      FS.copyFileSync(zonefile, '/etc/localtime');
      FS.writeFileSync('/etc/timezone', timezone);
      return true;
    }
    return false;
  },

  _setupDNS: function() {
    DNSForward.setDefaultResolver(
      this._env.DNSSERVER1.value,
      this._env.DNSSERVER2.value
    );
    DNSForward.setHostname(this._safeName());
    DNSForward.setDomainName(this.getLocalDomainName());
    return true;
  },

  _setupMDNS: function() {
    MDNS.start({
      uuid: this._env.GLOBALID.value,
      hostname: this._name,
      ipaddress: this._env.IPADDRESS.value
    });
    return true;
  },

  _setupUPNP: function() {
    UPNP.start({
      uuid: this._env.GLOBALID.value,
      hostname: this._name,
      ipaddress: this._env.IPADDRESS.value
    });
    return true;
  },

  _restart: function(reason) {
    FS.writeFileSync(RESTART_REASON, reason);
    if (!DEBUG) {
      ChildProcess.spawnSync(RESTART);
    }
  }

}

Util.inherits(MinkeSetup, EventEmitter);

module.exports = MinkeSetup;
