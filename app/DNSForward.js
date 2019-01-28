const ChildProcess = require('child_process');
const FS = require('fs');

const ETC = (process.env.DEBUG ? '/tmp/' : '/etc/');
const DNSMASQ = '/usr/sbin/dnsmasq';
const DNSMASQ_CONFIG = `${ETC}dnsmasq.conf`;
const DNSMASQ_CONFIG_DIR = `${ETC}dnsmasq.d/`;
const DNSMASQ_RESOLV = `${ETC}dnsmasq_resolv.conf`;

let dns = null;
let defaultResolver = '';
const resolvers = {};
const cacheSize = 256;

const DNSForward = {

  setDefaultResolver: function(resolver) {
    defaultResolver = resolver ? `nameserver ${resolver}\n` : '';
    DNSForward._updateResolv();
  },

  createForward: function(args) {
    const resolve = {
      name: args.name,
      IP4Address: args.IP4Address
    };
    resolvers[args.name] = resolve;
    DNSForward._updateResolv();
    return resolve;
  },

  removeForward: function(resolve) {
    delete resolvers[resolve.name];
    DNSForward._updateResolv();
  },

  _updateConfig: function() {
    FS.writeFileSync(DNSMASQ_CONFIG, `${[
      'user=root',
      `conf-dir=${DNSMASQ_CONFIG_DIR},*.conf`,
      `resolv-file=${DNSMASQ_RESOLV}`,
      'clear-on-reload',
      'strict-order',
      `cache-size=${cacheSize}`
    ].join('\n')}\n`);    
  },

  _updateResolv: function() {
    FS.writeFileSync(DNSMASQ_RESOLV, `${Object.values(resolvers).map((resolve) => {
      return `nameserver ${resolve.IP4Address} # For ${resolve.name}`;
    }).join('\n')}\n${defaultResolver}`);
  }

}

//
// Create default config.
//
DNSForward._updateResolv();
DNSForward._updateConfig();

//
// Start DNS server
//
if (!process.env.DEBUG) {
  dns = ChildProcess.spawn(DNSMASQ, []);
  dns.on('close', (code) => {
    // ...
  });
}

module.exports = DNSForward;
