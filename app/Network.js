const FS = require('fs');
const OS = require('os');
const Net = require('network');
const Netmask = require('netmask');
const Address6 = require('ip-address').Address6;
const Barrier = require('./utils/Barrier');

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const NETWORK_FILE = `${ETC}systemd/network/bridge.network`;
const HOME_NETWORK_NAME = 'home';
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
            netmask: new Netmask.Netmask(`${nic.ip_address}/${nic.netmask}`),
            dhcp: DEBUG ? false : this._getHomeNetworkFile().indexOf('DHCP=') != -1
          });
        }
      })
    });
  },

  getSLAACAddress: function() {
    const iface = OS.networkInterfaces()[BRIDGE_NETWORK];
    if (iface) {
      for (let i = 0; i < iface.length; i++) {
        if (iface[i].family === 'IPv6') {
          const a = new Address6(iface[i].address);
          if (a.getScope() === 'Global') {
            const mac = iface[i].mac.split(':').map(hex => parseInt(hex, 16));
            const slaac = a.toUnsignedByteArray();
            slaac[15] = mac[5];
            slaac[14] = mac[4];
            slaac[13] = mac[3];
            slaac[12] = 0xfe;
            slaac[11] = 0xff;
            slaac[10] = mac[2];
            slaac[9]  = mac[1];
            slaac[8]  = mac[0] ^ 0x02;
            const aslaac = Address6.fromUnsignedByteArray(slaac);
            if (a.canonicalForm() == aslaac.canonicalForm()) {
              return a;
            }
          }
        }
      }
    }
    return null;
  },

  generateSLAACAddress: function(macAddress) {
    const hslaac = this.getSLAACAddress();
    if (hslaac) {
      const mac = macAddress.split(':').map(hex => parseInt(hex, 16));
      const slaac = hslaac.toUnsignedByteArray();
      slaac[15] = mac[5];
      slaac[14] = mac[4];
      slaac[13] = mac[3];
      slaac[12] = 0xfe;
      slaac[11] = 0xff;
      slaac[10] = mac[2];
      slaac[9]  = mac[1];
      slaac[8]  = mac[0] ^ 0x02;
      return Address6.fromUnsignedByteArray(slaac);
    }
    return null;
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
      data =`[Match]\nName=${BRIDGE_NETWORK}\n\n[Network]\nDHCP=ipv4\nMulticastDNS=true\n\n[DHCP]\nUseDNS=false\n`;
    }
    else {
      const netmask = new Netmask.Netmask(`${config.address}/${config.netmask}`);
      data =`[Match]\nName=${BRIDGE_NETWORK}\n\n[Network]\nAddress=${config.address}/${netmask.bitmask}\nGateway=${config.gateway}\nMulticastDNS=true\n\n[DHCP]\nUseDNS=false\n`;
    }
    try {
      if (this._getHomeNetworkFile() != data) {
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
      // EnableIPv6: true, - NOT YET
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
  },

  _getHomeNetworkFile: function() {
    try {
      return FS.readFileSync(NETWORK_FILE, { encoding: 'utf8' });
    }
    catch (_) {
      return '';
    }
  }

}

module.exports = Network;
