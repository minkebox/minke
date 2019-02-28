const FS = require('fs');
const EventEmitter = require('events').EventEmitter;
const Util = require('util');
const Images = require('./Images');
const DNSForward = require('./DNSForward');
const Database = require('./Database');

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
  this._networks = {
    primary: 'host'
  };
  this._monitor = {};
  this._env = {
    LOCALDOMAIN: getEnv('LOCALDOMAIN'),
    IPADDRESS: getEnv('IPADDRESS'),
    NETMASK: getEnv('NETMASK'),
    GATEWAY: getEnv('GATEWAY'),
    DNSSERVER1: getEnv('DNSSERVER1'),
    DNSSERVER2 : getEnv('DNSSERVER2'),
    TIMEZONE: getEnv('TIMEZONE'),
    ADMINMODE: getEnv('ADMINMODE')
  };
  this._name = getEnv('HOSTNAME').value;
  this._homeIP = this._env.IPADDRESS.value;

  this._setupDNS();
  this._setupTimezone();
}

MinkeSetup.prototype = {

  start: async function() {
  },

  stop: async function() {
    this._status = 'shutting down';
    this.emit('update.status', { app: this, status: this._status });
  },

  restart: async function() {
    this.save();
    this._setupDNS();
    this._setupTimezone();
    this.emit('update.status', { app: this, status: this._status });
  },

  save: async function() {
    const config = {
      LOCALDOMAIN: null,
      DNSSERVER1: null,
      DNSSERVER2: null,
      ADMINMODE: null
    };
    for (let key in config) {
      config[key] = this._env[key].value;
    }
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

  _setupDNS: function() {
    DNSForward.setDefaultResolver(
      this._env.DNSSERVER1.value,
      this._env.DNSSERVER2.value
    );
    DNSForward.setHostname(this._safeName());
    DNSForward.setDomainName(this.getLocalDomainName());
    return true;
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
  }

}

Util.inherits(MinkeSetup, EventEmitter);

module.exports = MinkeSetup;
