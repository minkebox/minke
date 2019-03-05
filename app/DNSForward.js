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

let dns = null;
let domainName = 'home';
let hostname = 'Minke';
let primaryResolver = '';
let secondaryResolver = '';
const resolvers = {};
const cacheSize = 1024;

const DNSForward = {

  setDefaultResolver: function(resolver1, resolver2) {
    primaryResolver = resolver1 ? `server=${resolver1}#53\n` : '';
    secondaryResolver = resolver2 ? `server=${resolver2}#53\n` : '';
    DNSForward._updateResolv();
    DNSForward._restart();
  },

  createForward: function(args) {
    const resolve = {
      _id: args._id,
      name: args.name,
      IP4Address: args.IP4Address,
      Port: args.port || 53
    };
    resolvers[args._id] = resolve;
    DNSForward._updateResolv();
    DNSForward._restart();
    return resolve;
  },

  removeForward: function(resolve) {
    delete resolvers[resolve._id];
    DNSForward._updateResolv();
    DNSForward._restart();
  },

  setHostname: function(name) {
    hostname = name || 'Minke';
    FS.writeFileSync(HOSTNAME_FILE, `${hostname}\n`);
    if (!DEBUG) {
      ChildProcess.spawnSync(HOSTNAME, [ '-F', HOSTNAME_FILE ]);
    }
    this._restart();
  },

  setDomainName: function(domain) {
    domainName = domain || 'home';
    DNSForward._updateResolv();
    DNSForward._restart();
  },

  _updateConfig: function() {
    FS.writeFileSync(DNSMASQ_CONFIG, `${[
      'user=root',
      'no-resolv',
      `conf-dir=${DNSMASQ_CONFIG_DIR},*.conf`,
      'clear-on-reload',
      'strict-order',
      `cache-size=${cacheSize}`
    ].join('\n')}\n`);    
  },

  _updateResolv: function() {
    // Note. DNS servers are checked in reverse order
    FS.writeFileSync(DNSMASQ_RESOLV, `${secondaryResolver}${primaryResolver}${Object.values(resolvers).map((resolve) => {
      return `server=${resolve.IP4Address}#${resolve.Port}`;
    }).join('\n')}`);
    FS.writeFileSync(LOCAL_RESOLV, `domain ${domainName}\nsearch ${domainName}. local.\nnameserver 127.0.0.1\n`);
  },

  _restart: function() {
    if (dns) {
      dns.kill();
      dns = null;
    }
    MDNS.update({
      hostname: hostname
    });
    UPNP.update({
      hostname: hostname
    });
  }

}

//
// Create default config.
//
DNSForward._updateResolv();
DNSForward._updateConfig();

if (!DEBUG) {
  function dnsRun() {
    dns = ChildProcess.spawn(DNSMASQ, [ '-k' ]);
    dns.on('exit', dnsRun);
  }
  dnsRun();
}


module.exports = DNSForward;
