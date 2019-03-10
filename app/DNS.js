const ChildProcess = require('child_process');
const FS = require('fs');
const MDNS = require('./MDNS');
const UPNP = require('./UPNP');

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const DNSMASQ = '/usr/sbin/dnsmasq';
const HOSTNAME = '/bin/hostname';
const DNSMASQ_CONFIG = `${ETC}dnsmasq.conf`;
const DNSMASQ_CONFIG_DIR = (DEBUG ? '/tmp/' : `${ETC}dnsmasq.d/`);
const DNSMASQ_RESOLV = `${DNSMASQ_CONFIG_DIR}resolv.conf`;
const HOSTNAME_FILE = `${ETC}hostname`;
const LOCAL_RESOLV = `${ETC}resolv.conf`;
const DNSMASQ_HOSTS_DIR = (DEBUG ? '/tmp/' : `${ETC}dnshosts.d/`);
const MINKE_HOSTS = `${DNSMASQ_HOSTS_DIR}hosts.conf`;

let dns = null;
let domainName = 'home';
let hostname = 'Minke';
let primaryResolver = '';
let secondaryResolver = '';
const resolvers = {};
const cacheSize = 1024;
const hosts = {};

const DNS = {

  setDefaultResolver: function(resolver1, resolver2) {
    primaryResolver = resolver1 ? `server=${resolver1}#53\n` : '';
    secondaryResolver = resolver2 ? `server=${resolver2}#53\n` : '';
    this._updateResolvServers();
    this._restartDNS();
  },

  createForward: function(args) {
    const resolve = {
      _id: args._id,
      name: args.name,
      IP4Address: args.IP4Address,
      Port: args.port || 53
    };
    resolvers[args._id] = resolve;
    this._updateResolvServers();
    this._restartDNS();
    return resolve;
  },

  removeForward: function(resolve) {
    delete resolvers[resolve._id];
    this._updateResolvServers();
    this._restartDNS();
  },

  setHostname: function(name) {
    hostname = name || 'Minke';
    FS.writeFileSync(HOSTNAME_FILE, `${hostname}\n`);
    if (!DEBUG) {
      ChildProcess.spawnSync(HOSTNAME, [ '-F', HOSTNAME_FILE ]);
    }
    MDNS.update({ hostname: hostname });
    UPNP.update({ hostname: hostname });
  },

  setDomainName: function(domain) {
    domainName = domain || 'home';
    this._updateLocalResolv();
    this._updateHosts();
    this._reloadDNS();
  },

  registerHostIP: async function(hostname, ip) {
    hosts[hostname] = ip;
    this._updateHosts();
    this._reloadDNS();
  },

  unregisterHostIP: async function(hostname, ip) {
    delete hosts[hostname];
    this._updateHosts();
    this._reloadDNS();
  },

  _updateConfig: function() {
    FS.writeFileSync(DNSMASQ_CONFIG, `${[
      'user=root',
      'no-poll',
      'bind-interfaces',
      'no-resolv',
      `conf-dir=${DNSMASQ_CONFIG_DIR},*.conf`,
      `hostsdir=${DNSMASQ_HOSTS_DIR}`,
      'clear-on-reload',
      'strict-order',
      `cache-size=${cacheSize}`
    ].join('\n')}\n`);    
  },

  _updateLocalResolv: function() {
    FS.writeFileSync(LOCAL_RESOLV, `domain ${domainName}\nsearch ${domainName}. local.\nnameserver 127.0.0.1\n`);
  },

  _updateResolvServers: function() {
    // Note. DNS servers are checked in reverse order
    FS.writeFileSync(DNSMASQ_RESOLV, `${secondaryResolver}${primaryResolver}${Object.values(resolvers).map((resolve) => {
      return `server=${resolve.IP4Address}#${resolve.Port}\n`;
    })}`);
  },

  _updateHosts: function() {
    FS.writeFileSync(MINKE_HOSTS, Object.keys(hosts).map((host) => {
      return `${hosts[host]} ${host} ${host}.${domainName}\n`
    }).join(''));
  },

  _reloadDNS: function() {
    if (dns) {
      dns.kill('SIGHUP');
    }
  },

  _restartDNS: function() {
    dns.kill();
    dns = ChildProcess.spawn(DNSMASQ, [ '-k' ]);
  },

}

//
// Create default config.
//
DNS._updateLocalResolv();
DNS._updateResolvServers();
DNS._updateConfig();

if (!DEBUG) {
  dns = ChildProcess.spawn(DNSMASQ, [ '-k' ]);
}


module.exports = DNS;
