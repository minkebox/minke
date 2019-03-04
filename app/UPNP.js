const SSDP = require('@achingbrain/ssdp');

let ssdp;

const UPNP = {

  _uuid: '',
  _hostname: '',
  _ip: '0.0.0.0',

  register: function(root) {
    root.get('/rootDesc.xml', async (ctx) => {
      ctx.type = 'text/xml';
      ctx.body =
`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
      <major>1</major>
      <minor>0</minor>
  </specVersion>
  <device>
      <deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
      <friendlyName>${UPNP._hostname} (MinkeBox)</friendlyName>
      <manufacturer>Minke</manufacturer>
      <manufacturerURL>https://minkebox.com/</manufacturerURL>
      <modelName>MinkeBox</modelName>
      <modelNumber>0.0.1</modelNumber>
      <modelURL>https://minkebox.com/</modelURL>
      <serialNumber>${UPNP._uuid}</serialNumber>
      <UDN>uuid:${UPNP._uuid}</UDN>
      <serviceList>
      </serviceList>
      <presentationURL>http://${UPNP._ip}/</presentationURL>
  </device>
</root>`;
    });
  },

  start: async function(config) {
  
    this._uuid = config.uuid;
    this._hostname = config.hostname;
    this._ip = config.ipaddress;

    ssdp = SSDP({
      udn: `uuid:${this._uuid}`,
      signature: 'minkebox UPnP/1.1',
    });

    await ssdp.advertise({
      usn: 'upnp:rootdevice',
      location: {
        udp4: `http://${this._ip}/rootDesc.xml`
      },
      shutDownServers: () => {
        return [];
      }
    });
  },

  stop: async function() {
    if (ssdp) {
      await ssdp.stop();
      ssdp = null;
    }
  },

  update: function(config) {
    this._hostname = config.hostname;
  }

};

module.exports = UPNP;
