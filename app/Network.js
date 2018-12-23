const Net = require('network');
const Crypto = require('crypto');
const Netmask = require('netmask');
const Dhcp = require('./dhcp');

const leases = {};
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

  _generateMacAddress: function(name) {
    const hash = Crypto.createHash('sha256').update(name).digest('hex');
    return `06:${hash[0]}${hash[1]}:${hash[2]}${hash[3]}:${hash[4]}${hash[5]}:${hash[6]}${hash[7]}:${hash[8]}${hash[9]}`;
  },

  getHomeIP4: async function(hostname) {
    return new Promise((resolve) => {
      const macAddress = Network._generateMacAddress(hostname);
      const dhcpClient = Dhcp.createClient({
        mac: macAddress,
        features: 0,
        hostname: hostname.replace(/\//g, '-')
      });

      let pending = true;
      dhcpClient.on('bound', (state) => {
        if (pending) {
          pending = false;
          leases[state.address] = {};
          resolve({
            address: state.address,
            gateway: state.options.router,
            mac: macAddress
          });
        }
        clearTimeout(leases[state.address].renewTimer);
        leases[state.address].renewTimer = setTimeout(() => {
          dhcpClient.sendRenew();
        }, state.renewPeriod * 1000);
      });
      dhcpClient.listen(null, null, () => {
        dhcpClient.sendDiscover();
      });
    });
  },

  releaseHomeIPAddress: function(ipaddr) {
    if (leases[ipaddr]) {
      clearTimeout(leases[ipaddr].renewTimer);
      delete leases[ipaddr];
    }
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
