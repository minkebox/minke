const FS = require('fs');
const Net = require('network');
const Netmask = require('netmask');
const Barrier = require('./utils/Barrier');

const DEBUG = process.env.DEBUG;

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const NETWORK_FILE = `${ETC}systemd/network/bridge.network`;
const HOME_NETWORK_NAME = 'home';
const MANAGEMENT_NETWORK_NAME = 'management';
const BRIDGE_NETWORK = 'br0';

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

  getPrivateNetwork: Barrier(async function(networkId) {
    return await this._getNetwork({
      Name: networkId,
      CheckDuplicate: true,
      Driver: 'bridge'
    });
  }),

  setHomeNetwork: function(config) {
    if (DEBUG) {
      return false;
    }
    // address, netmask, gateway
    let data = '';
    if (config.address.toLowerCase() === 'dhcp') {
      data =`[Match]\nName=${BRIDGE_NETWORK}\n\n[Network]\nDHCP=ipv4\n`;
    }
    else {
      const netmask = new Netmask.Netmask(`${config.address}/${config.netmask}`);
      data =`[Match]\nName=${BRIDGE_NETWORK}\n\n[Network]\nAddress=${config.address}/${netmask.bitmask}\nGateway=${config.gateway}\n`;
    }
    try {
      const olddata = FS.readFileSync(NETWORK_FILE, { encoding: 'utf8' });
      if (olddata != data) {
        FS.writeFileSync(NETWORK_FILE, data);
        return true;
      }
      else {
        return false;
      }
    }
    catch (_) {
      return false;
    }
  },

  getHomeNetwork: Barrier(async function() {
    const net = networks[HOME_NETWORK_NAME];
    if (net) {
      return net;
    }

    const iface = await Network.getActiveInterface();
    return await this._getNetwork({
      Name: HOME_NETWORK_NAME,
      Driver: 'bridge',
      IPAM: {
        Config: [{
          Subnet: `${iface.netmask.base}/${iface.netmask.bitmask}`,
          Gateway: iface.network.ip_address, // Dont use gateway_ip - set that using aux. This (re)sets the host IP address.
          AuxiliaryAddresses: {
            DefaultGatewayIPv4: iface.network.gateway_ip
          }
        }]
      },
      Options: {
        'com.docker.network.bridge.name': BRIDGE_NETWORK
      }
    });
  }),

  getBridgeNetwork: Barrier(async function() {
    return await this._getNetwork({
      Name: 'bridge'
    });
  }),

  getManagementNetwork: Barrier(async function() {
    return await this._getNetwork({
      Name: MANAGEMENT_NETWORK_NAME,
      CheckDuplicate: true,
      Driver: 'bridge'
    });
  }),

  _getNetwork: async function(config) {
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
  }

}

module.exports = Network;
