const ChildProcess = require('child_process');
const FS = require('fs');

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const DNSMASQ = '/usr/sbin/dnsmasq';
const HOSTNAME = '/bin/hostname';
const DNSMASQ_CONFIG = `${ETC}dnsmasq.conf`;
const DNSMASQ_RESOLV = `${ETC}dnsmasq-servers.conf`;
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

  start: function(config) {
    this.setHostname(config.hostname);
    this.setDomainName(config.domainname);
    this.setDefaultResolver(config.resolvers[0], config.resolvers[1]);
  },

  setDefaultResolver: function(resolver1, resolver2) {
    primaryResolver = resolver1 ? `server=${resolver1}#53\n` : '';
    secondaryResolver = resolver2 ? `server=${resolver2}#53\n` : '';
    this._updateResolvServers();
    this._reloadDNS();
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
    this._reloadDNS();
    return resolve;
  },

  removeForward: function(resolve) {
    delete resolvers[resolve._id];
    this._updateResolvServers();
    this._reloadDNS();
  },

  setHostname: function(name) {
    hostname = name || 'Minke';
    if (!DEBUG) {
      FS.writeFileSync(HOSTNAME_FILE, `${hostname}\n`);
      ChildProcess.spawnSync(HOSTNAME, [ '-F', HOSTNAME_FILE ]);
    }
  },

  setDomainName: function(domain) {
    domainName = domain || 'home';
    this._updateLocalResolv();
    if (!DEBUG) {
      for (let hostname in hosts) {
        FS.writeFileSync(`${DNSMASQ_HOSTS_DIR}${hostname}.conf`, `${hosts[hostname]} ${hostname} ${hostname}.${domainName}\n`);
      }
    }
  },

  registerHostIP: async function(hostname, ip) {
    hosts[hostname] = ip;
    if (!DEBUG) {
      FS.writeFileSync(`${DNSMASQ_HOSTS_DIR}${hostname}.conf`, `${ip} ${hostname} ${hostname}.${domainName}\n`);
    }
  },

  unregisterHostIP: async function(hostname, ip) {
    delete hosts[hostname];
    if (!DEBUG) {
      try {
        FS.unlinkSync(`${DNSMASQ_HOSTS_DIR}${hostname}.conf`);
      }
      catch (e) {
        console.error(e);
      }
    }
  },

  _updateConfig: function() {
    if (!DEBUG) {
      FS.writeFileSync(DNSMASQ_CONFIG, `${[
        'user=root',
        'bind-interfaces',
        'no-resolv',
        `servers-file=${DNSMASQ_RESOLV}`,
        `hostsdir=${DNSMASQ_HOSTS_DIR}`,
        'clear-on-reload',
        'strict-order',
        `cache-size=${cacheSize}`
      ].join('\n')}\n`);
    }
  },

  _updateLocalResolv: function() {
    if (!DEBUG) {
      FS.writeFileSync(LOCAL_RESOLV, `domain ${domainName}\nsearch ${domainName}. local.\nnameserver 127.0.0.1\n`);
    }
  },

  _updateResolvServers: function() {
    if (!DEBUG) {
      // Note. DNS servers are checked in reverse order
      FS.writeFileSync(DNSMASQ_RESOLV, `${secondaryResolver}${primaryResolver}${Object.values(resolvers).map((resolve) => {
        return `server=${resolve.IP4Address}#${resolve.Port}\n`;
      }).join('')}`);
    }
  },

  _updateHosts: function() {
    if (!DEBUG) {
      FS.writeFileSync(MINKE_HOSTS, Object.keys(hosts).map((host) => {
        return `${hosts[host]} ${host} ${host}.${domainName}\n`
      }).join(''));
    }
  },

  _reloadDNS: function() {
    if (dns) {
      dns.kill('SIGHUP');
    }
  },

  _restartDNS: function() {
    if (dns) {
      dns.kill();
      dns = ChildProcess.spawn(DNSMASQ, [ '-k' ]);
    }
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
