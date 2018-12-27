const Net = require('network');
const Netmask = require('netmask');

const HOME_NETWORK_NAME = 'home';
let hostNetwork = null;

const Network = {

  getActiveInterface: async function() {
    return new Promise((resolve, reject) => {
      Net.get_active_interface((err, nic) => {
        if (err) {
          reject(err);
        }
        else {
          resolve({
            network: nic,
            netmask: new Netmask.Netmask(`${nic.ip_address}/${nic.netmask}`)
          });
        }
      })
    });
  },

  getHostNetwork: async function() {
    if (!hostNetwork) {
      const network = docker.getNetwork(HOME_NETWORK_NAME);
      try
      {
        await network.inspect();
        hostNetwork = network;
      }
      catch (_)
      {
        const iface = await Network.getActiveInterface();
        hostNetwork = await docker.createNetwork({
          Name: HOME_NETWORK_NAME,
          Driver: 'macvlan',
          IPAM: {
            Config: [{
              Subnet: `${iface.netmask.base}/${iface.netmask.bitmask}`,
              Gateway: iface.network.gateway_ip
            }]
          },
          Options: {
            parent: iface.network.name
          }
        });
      }
    }
    return hostNetwork;
  },

  getBridgeNetwork: async function() {
    return docker.getNetwork('bridge');
  },

}

module.exports = Network;
