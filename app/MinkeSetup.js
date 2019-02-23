const Images = require('./Images');
const DNSForward = require('./DNSForward');
const Database = require('./Database');
const MinkeApp = require('./MinkeApp');

function MinkeSetup(savedConfig, config) {

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
    HOSTNAME: getEnv('HOSTNAME'),
    LOCALDOMAIN: getEnv('LOCALDOMAIN'),
    IPADDRESS: getEnv('IPADDRESS'),
    DNSSERVER1: getEnv('DNSSERVER1'),
    DNSSERVER2 : getEnv('DNSSERVER2'),
    TIMEZONE: getEnv('TIMEZONE'),
    NTPSERVER: getEnv('NTPSERVER'),
    ADMINMODE: getEnv('ADMINMODE')
  };
  this._name = this._env.HOSTNAME.value;
  this._homeIP = this._env.IPADDRESS.value;

  this._setupDNS();
}

MinkeSetup.prototype = {

  start: async function() {
  },

  stop: async function() {
  },

  restart: async function() {
    this.save();
    this._setupDNS();
  },

  save: async function() {
    const config = {
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

  _safeName: function() {
    return this._name;
  },

  _willCreateNetwork: function() {
    return false;
  },

  on: function() {
  },

  off: function() {
  },

  getAdminMode: function() {
    return this._env.ADMINMODE.value === 'ENABLED';
  },

  _setupDNS: function() {
    DNSForward.setDefaultResolver(
      this._env.DNSSERVER1.value,
      this._env.DNSSERVER2.value
    );
  }

}

module.exports = MinkeSetup;
