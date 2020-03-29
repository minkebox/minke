const FS = require('fs');
const OS = require('os');
const ChildProcess = require('child_process');
const Net = require('network');
const Netmask = require('netmask');
const Address6 = require('ip-address').Address6;
const DetectRpi = require('detect-rpi');
const Barrier = require('./utils/Barrier');

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const BRIDGE_NETWORK_FILE = `${ETC}systemd/network/bridge.network`;
const WIRED_NETWORK_FILE = `${ETC}systemd/network/wired.network`;
const WLAN_NETWORK_FILE = `${ETC}systemd/network/wlan.network`;
const WPA_SUPPLICANT_FILE = `${ETC}wpa_supplicant.conf`;
const HOME_NETWORK_NAME = 'home';
const BRIDGE_NETWORK = 'br0';
const WIRED_NETWORKS = 'en* eth*';
const WLAN_NETWORK = 'wlan0';
const WIRED_NETWORK_FALLBACK = "192.168.1.200/24";
const FALLBACK_NETWORK = 'eth0';

const networks = {};
let wifiAvailable = null;

const Network = {

  BRIDGE_NETWORK: BRIDGE_NETWORK,
  WLAN_NETWORK: WLAN_NETWORK,

  getActiveInterface: async function() {
    return new Promise((resolve, reject) => {
      Net.get_interfaces_list((err, list) => {
        if (err) {
          return reject(err);
        }
        let net = '';
        let iface = null;
        try {
          iface = list.find(item => item.name === WLAN_NETWORK);
          if (iface && iface.ip_address) {
            net = FS.readFileSync(WLAN_NETWORK_FILE, { encoding: 'utf8' });
          }
          else {
            iface = list.find(item => item.name === BRIDGE_NETWORK);
            if (iface) {
              net = FS.readFileSync(BRIDGE_NETWORK_FILE, { encoding: 'utf8' });
            }
            else {
              iface = list.find(item => item.name === FALLBACK_NETWORK);
              if (iface) {
                net = '';
              }
            }
          }
        }
        catch (_) {
        }
        if (!iface) {
          return reject('No active interface');
        }
        resolve({
          network: iface,
          netmask: new Netmask.Netmask(`${iface.ip_address}/${iface.netmask}`),
          dhcp: net.indexOf('DHCP=') != -1
        });
      })
    });
  },

  _getHostSLAACAddress: function() {
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

  getSLAACAddress: function() {
    const hslaac = this._getHostSLAACAddress();
    if (hslaac) {
      return hslaac.canonicalForm();
    }
    else {
      return null;
    }
  },

  generateSLAACAddress: function(macAddress) {
    const hslaac = this._getHostSLAACAddress();
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
      return Address6.fromUnsignedByteArray(slaac).canonicalForm();
    }
    return null;
  },

  getPrivateNetwork: Barrier(async function(networkId) {
    return await this._getNetwork({
      Name: networkId,
      CheckDuplicate: true,
      Driver: 'bridge',
      Options: {
        'com.docker.network.bridge.enable_ip_masquerade': 'false',
        'com.docker.network.driver.mtu': '1400'
      }
    });
  }),

  setHomeNetwork: function(config) {
    if (DEBUG) {
      return false;
    }
    let data = '';
    if (config.enable) {
      // address, netmask, gateway
      if (config.address.toLowerCase() === 'dhcp') {
        data =`[Match]\nName=${BRIDGE_NETWORK}\n\n[Network]\nDHCP=ipv4\n\n[DHCP]\nUseDNS=false\n`;
      }
      else {
        const netmask = new Netmask.Netmask(`${config.address}/${config.netmask}`);
        data =`[Match]\nName=${BRIDGE_NETWORK}\n\n[Network]\nAddress=${config.address}/${netmask.bitmask}\nGateway=${config.gateway}\n\n[DHCP]\nUseDNS=false\n`;
      }
    }
    else {
      data =`[Match]\nName=${BRIDGE_NETWORK}\n`;
    }
    try {
      FS.writeFileSync(BRIDGE_NETWORK_FILE, data);
      return true;
    }
    catch (_) {
      return false;
    }
  },

  setWiFiNetwork: function(config) {
    if (DEBUG) {
      return false;
    }
    let wpa = '';
    let net = '';
    if (config.enable) {
      wpa = `ctrl_interface=/var/run/wpa_supplicant\nctrl_interface_group=0\nupdate_config=1\nnetwork={\n  ssid="${config.network}"\n  psk="${config.password}"\n}\n`;
      if (config.address.toLowerCase() === 'dhcp') {
        net =`[Match]\nName=${WLAN_NETWORK}\n\n[Network]\nDHCP=ipv4\n\n[DHCP]\nUseDNS=false\n`;
      }
      else {
        const netmask = new Netmask.Netmask(`${config.address}/${config.netmask}`);
        net =`[Match]\nName=${WLAN_NETWORK}\n\n[Network]\nAddress=${config.address}/${netmask.bitmask}\nGateway=${config.gateway}\n\n[DHCP]\nUseDNS=false\n`;
      }
    }
    else {
      net =`[Match]\nName=${WLAN_NETWORK}\n`;
    }
    try {
      FS.writeFileSync(WLAN_NETWORK_FILE, net);
      FS.writeFileSync(WPA_SUPPLICANT_FILE, wpa);
      return true;
    }
    catch (_) {
      return false;
    }
  },

  setWiredNetwork: function(config) {
    if (DEBUG) {
      return false;
    }
    let net = '';
    if (config.enable) {
      net =`[Match]\nName=${WIRED_NETWORKS}\n\n[Network]\nBridge=${BRIDGE_NETWORK}\n`;
    }
    else {
      net =`[Match]\nName=${WIRED_NETWORKS}\n\n[Network]\nAddress=${WIRED_NETWORK_FALLBACK}\n`;
    }
    try {
      FS.writeFileSync(WIRED_NETWORK_FILE, net);
      return true;
    }
    catch (_) {
      return false;
    }
  },

  getHomeNetwork: Barrier(async function() {
    let net = networks[HOME_NETWORK_NAME];
    if (!net) {
      const iface = await Network.getActiveInterface();
      net = await this._getNetwork({
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
          'com.docker.network.bridge.name': BRIDGE_NETWORK,
          'com.docker.network.bridge.enable_ip_masquerade': 'false'
        }
      });
    }
    return net;
  }),

  wifiAvailable: async function() {
    if (wifiAvailable === null) {
      wifiAvailable = DetectRpi();
    }
    return wifiAvailable;
  },

  registerIP: function(ip) {
    ChildProcess.spawnSync('/sbin/ip', [
      'route', 'add', `${ip}/32`, 'dev', BRIDGE_NETWORK, 'metric', '50'
    ]);
  },

  unregisterIP: function(ip) {
    ChildProcess.spawnSync('/sbin/ip', [
      'route', 'del', `${ip}/32`, 'dev', BRIDGE_NETWORK, 'metric', '50'
    ]);
  },

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
          // Create network and then get it again. *DONT* use the network
          // returned from createNetwork as this doesn't handle mac addresses
          // correctly.
          await docker.createNetwork(config);
          net = docker.getNetwork(config.Name);
          net.info = await net.inspect();
          networks[config.Name] = net;
        }
      }
    }
    return net;
  }

}

module.exports = Network;
