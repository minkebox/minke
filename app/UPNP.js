const ChildProcess = require('child_process');
const Upnp = require('./upnp');
const Network = require('./Network');

const UPNP = {

  create: async function(ipaddress) {

    const iface = await Network.getActiveInterface();
    const wan = await UPNP._getWan();
    const target = await UPNP._getExternalIP();
    let woke = 0;
    let timer = null;
    const actives = [];
    
    return {
  
      exposePort: async function(protocol, port) {
        const ttl = 3600; // 1 hour
        this.wake();
        await wan.addPortMapping(target, port, ipaddress, port, protocol, ttl);
        actives.push({ port: port, protocol: protocol });
        if (!timer) {
          timer = setInterval(async () => {
            this.wake();
            await Promise.all(actives.map(async (active) => {
              await wan.addPortMapping(target, active.port, ipaddress, active.port, active.protocol, ttl);
            }));
            this.sleep();
          }, ttl / 2 * 1000);
        }
      },

      unexposeAll: async function() {
        this.wake();
        await Promise.all(actives.map(async (active) => {
          await wan.removePortMapping(target, ipaddress, active.port, active.protocol);
        }));
        actives.length = 0;
        this.sleep();
      },

      wake: function() {
        if (woke++ === 0 && iface.network.ip_address != ipaddress) {
          // We're creating a NAT for another service. The NAT service may be secure and not support this
          // unless the request comes from the same ip as the service.
          ChildProcess.spawnSync('/bin/ip', [ 'address', 'add', `${ipaddress}/${iface.netmask.bitmask}`, 'dev', iface.network.name ]);
          //console.log('/bin/ip', [ 'address', 'add', `${ipaddress}/${iface.netmask.bitmask}`, 'dev', iface.network.name ]);
        }
      },

      sleep: function() {
        if (--woke === 0 && iface.network.ip_address != ipaddress) {
          ChildProcess.spawnSync('/bin/ip', [ 'address', 'del', `${ipaddress}/${iface.netmask.bitmask}`, 'dev', iface.network.name ]);
          //console.log('/bin/ip', [ 'address', 'del', `${ipaddress}/${iface.netmask.bitmask}`, 'dev', iface.network.name ]);
        }
      }
    }
  },

  

  _getWan: async function() {
    if (!UPNP._wan) {
      UPNP._wan = await Upnp.discover();
    }
    return UPNP._wan;
  },

  _getExternalIP: async function() {
    if (!UPNP._external) {
      UPNP._external = await (await UPNP._getWan()).getExternalIP();
    }
    return UPNP._external;
  }

};

module.exports = UPNP;
