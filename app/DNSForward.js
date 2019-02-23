const ChildProcess = require('child_process');
const FS = require('fs');

const ETC = (process.env.DEBUG ? '/tmp/' : '/etc/');
const DNSMASQ = '/usr/sbin/dnsmasq';
const DNSMASQ_CONFIG = `${ETC}dnsmasq.conf`;
const DNSMASQ_CONFIG_DIR = (process.env.DEBUG ? '/tmp/' : `${ETC}dnsmasq.d/`);
const DNSMASQ_RESOLV = `${DNSMASQ_CONFIG_DIR}resolv.conf`;

let dns = null;
let primaryResolver = '';
let secondaryResolver = '';
const resolvers = {};
const cacheSize = 256;

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
  },

  _restart: function() {
    if (dns) {
      dns.kill();
      dns = null;
    }
  }

}

//
// Create default config.
//
DNSForward._updateResolv();
DNSForward._updateConfig();

if (!process.env.DEBUG) {
  function run() {
    dns = ChildProcess.spawn(DNSMASQ, [ '-k' ]);
    dns.on('exit', run);
  }
  run();
}


module.exports = DNSForward;
