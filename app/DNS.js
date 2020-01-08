const ChildProcess = require('child_process');
const FS = require('fs');
const Network = require('./Network');

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const DNSMASQ = '/usr/sbin/dnsmasq';
const DNSCRYPT = '/usr/bin/dnscrypt-proxy';
const HOSTNAME = '/bin/hostname';
const DNSMASQ_CONFIG = `${ETC}dnsmasq.conf`;
const DNSCRYPT_CONFIG = `${ETC}dnscrypt-proxy.toml`;
const DNSMASQ_RESOLV = `${ETC}dnsmasq-servers.conf`;
const HOSTNAME_FILE = `${ETC}hostname`;
const LOCAL_RESOLV = `${ETC}resolv.conf`;
const DNSMASQ_HOSTS_DIR = (DEBUG ? '/tmp/' : `${ETC}dnshosts.d/`);
const MINKE_HOSTS = `${DNSMASQ_HOSTS_DIR}hosts.conf`;
const DEFAULT_FALLBACK_RESOLVER = '1.1.1.1';

let dns = null;
let dnsc = null;
let domainName = 'home';
let hostname = 'MinkeBox';
let primaryResolver = '';
let secondaryResolver = '';
let secureResolver = null;
const resolvers = {};
const cacheSize = 1024;
const hosts = {};

const DNS = {

  start: function(config) {
    this.setHostname(config.hostname);
    this.setDomainName(config.domainname);
    this.setDefaultResolver(config.resolvers[0], config.resolvers[1], config.secure[0], config.secure[1]);
  },

  setDefaultResolver: function(resolver1, resolver2, secureDNS1, secureDNS2) {
    if (!secureDNS1 && !secureDNS2) {
      primaryResolver = resolver1 ? `server=${resolver1}#53\n` : '';
      secondaryResolver = resolver2 ? `server=${resolver2}#53\n` : '';
      secureResolver = null;
    }
    else {
      primaryResolver = `server=127.0.0.1#5453\n`;
      secondaryResolver = '';
      const fallback = resolver1 ? resolver1 : resolver2 ? resolver2 : DEFAULT_FALLBACK_RESOLVER;
      secureResolver = [
        `listen_addresses = ['127.0.0.1:5453']`,
        `netprobe_address = '${fallback}:53'`,
        `fallback_resolver = '${fallback}:53'`
      ];
      if (!secureDNS1) {
        secureDNS1 = secureDNS2;
        secureDNS2 = null;
      }
      if (secureDNS2) {
        secureResolver = secureResolver.concat([
          `server_names = ['primary','secondary']`,
          `[static.'primary']`,
          `stamp = '${secureDNS1}'`,
          `[static.'secondary']`,
          `stamp = '${secureDNS2}'`
        ]);
      }
      else {
        secureResolver = secureResolver.concat([
          `server_names = ['primary']`,
          `[static.'primary']`,
          `stamp = '${secureDNS1}'`
        ]);
      }
    }
    this._updateResolvServers();
    this._updateSecureConfig();
    this._reloadDNS();
    this._restartDNSC();
  },

  setSecureDNS: function(secure) {
    secureDns = secure;
  },

  createForward: function(args) {
    const options = args.options || {};
    const resolve = {
      _id: args._id,
      name: args.name,
      IP4Address: args.IP4Address,
      Port: args.port || 53,
      priority: options.priority || 5,
      delay: options.delay || 0
    };
    resolvers[args._id] = resolve;
    if (resolve.delay) {
      setTimeout(() => {
        resolve.delay = 0;
        this._updateResolvServers();
        this._reloadDNS();
      }, resolve.delay * 1000);
    }
    else {
      this._updateResolvServers();
      this._reloadDNS();
    }
    return resolve;
  },

  removeForward: function(resolve) {
    delete resolvers[resolve._id];
    this._updateResolvServers();
    this._reloadDNS();
  },

  setHostname: function(name) {
    hostname = name || 'MinkeBox';
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
      if (hostname.indexOf('.') === -1) {
        FS.writeFileSync(`${DNSMASQ_HOSTS_DIR}${hostname}.conf`, `${ip} ${hostname} ${hostname}.${domainName}\n`);
      }
      else {
        FS.writeFileSync(`${DNSMASQ_HOSTS_DIR}${hostname}.conf`, `${ip} ${hostname}\n`);
      }
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

  _updateSecureConfig: function() {
    if (secureResolver) {
      FS.writeFileSync(DNSCRYPT_CONFIG, `${[
        `max_clients = 250`,
        `ipv4_servers = true`,
        `ipv6_servers = ${!!Network.getSLAACAddress()}`,
        `dnscrypt_servers = true`,
        `doh_servers = true`,
        `require_nolog = true`,
        `require_nofilter = true`,
        `force_tcp = false`,
        `timeout = 5000`,
        `keepalive = 30`,
        `cert_refresh_delay = 240`,
        `ignore_system_dns = true`,
        `log_files_max_size = 10`,
        `log_files_max_age = 7`,
        `log_files_max_backups = 1`,
        `block_ipv6 = false`,
        `#block_unqualified = true`,
        `#reject_ttl = 600`,
        `cache = true`,
        `cache_size = 1024`,
        `cache_min_ttl = 2400`,
        `cache_max_ttl = 86400`,
        `cache_neg_min_ttl = 60`,
        `cache_neg_max_ttl = 600`,
        `netprobe_timeout = 60`
      ].concat(secureResolver).join('\n')}\n`);
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
      const dns = Object.values(resolvers);
      dns.sort((a, b) => b.priority - a.priority);
      FS.writeFileSync(DNSMASQ_RESOLV, `${secondaryResolver}${primaryResolver}${dns.map((resolve) => {
        return resolve.delay === 0 ? `server=${resolve.IP4Address}#${resolve.Port}\n` : '';
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

  _restartDNSC: function() {
    if (dnsc) {
      dnsc.kill();
    }
    if (secureResolver && !DEBUG) {
      dnsc = ChildProcess.spawn(DNSCRYPT, [ '-config', DNSCRYPT_CONFIG ]);
    }
  }

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
