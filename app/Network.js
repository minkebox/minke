const Net = require('network');
const Netmask = require('netmask');
const Barrier = require('./utils/Barrier');

const HOME_NETWORK_NAME = 'home';
const MANAGEMENT_NETWORK_NAME = 'management';
const networks = {};

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

  getPrivateNetwork: async function(networkName) {
    return await this._getNetwork({
      Name: networkName.replace(/[^a-zA-Z0-9]/g, ''),
      CheckDuplicate: true,
      Driver: 'bridge'
    });
  },

  getHomeNetwork: async function() {
    let net = networks[HOME_NETWORK_NAME];
    if (net) {
      return net;
    }
    const iface = await Network.getActiveInterface();
    return await this._getNetwork({
      Name: HOME_NETWORK_NAME,
      CheckDuplicate: true,
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
  },

  getBridgeNetwork: async function() {
    return await this._getNetwork({
      Name: 'bridge'
    });
  },

  getManagementNetwork: async function() {
    return await this._getNetwork({
      Name: MANAGEMENT_NETWORK_NAME,
      CheckDuplicate: true,
      Driver: 'bridge'
    });
  },

  _getNetwork: Barrier(async function(config) {
    let net = networks[config.Name];
    if (!net) {
      net = docker.getNetwork(config.Name);
      try {
        net.info = await net.inspect();
        networks[config.Name] = net;
        return net;
      }
      catch (_) {
        if (config.Driver) {
          net = await docker.createNetwork(config);
          net.info = await net.inspect();
          networks[config.Name] = net;
        }
      }
    }
    return net;
  })

}

module.exports = Network;
