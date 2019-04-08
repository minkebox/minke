const SSDP = require('@achingbrain/ssdp');
const URL = require('url').URL;
const HTTP = require('http');

const URN_WAN= 'urn:schemas-upnp-org:service:WANIPConnection:1';
const URN_IGD = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
const TIMEOUT = 5 * 1000;
const RETRY = 6;

let ssdp;

const UPNP = {

  _uuid: '',
  _hostname: '',
  _ip: '0.0.0.0',
  _WANIPConnectionURL: null,

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
      <presentationURL>http://${UPNP._ip}:${UPNP._port}/</presentationURL>
  </device>
</root>`;
    });
  },

  start: async function(config) {
  
    this._uuid = config.uuid;
    this._hostname = config.hostname;
    this._ip = config.ipaddress;
    this._port = config.port;

    ssdp = SSDP({
      udn: `uuid:${this._uuid}`,
      signature: 'minkebox UPnP/1.1',
    });

    await ssdp.advertise({
      usn: 'upnp:rootdevice',
      location: {
        udp4: `http://${this._ip}/rootDesc.xml`
      },
      ttl: 60 * 1000, // ttl == 60 seconds
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
  },

  getExternalIP: async function() {
    if (ssdp) {
      if (!this._WANIPConnectionURL) {
        this._WANIPConnectionURL = await new Promise(async (resolve) => {
          let location = null;
          const search = (res) => {
            if (res.ST === URN_IGD) {
              location = new URL(res.LOCATION);
            }
          }
          const discover = async (service) => {
            if (location) {
              for (let ptr = service.details; ptr && ptr.device; ptr = ptr.device.deviceList) {
                const list = ptr.device.serviceList;
                if (list && list.service && list.service.serviceType === URN_WAN) {
                  resolve(new URL(list.service.controlURL, location.origin));
                  resolve = null;
                }
              }
            }
          }
          ssdp.on('ssdp:search-response', search);
          ssdp.on(`discover:${URN_IGD}`, discover);
          // Retry the discover process until we succeed (or eventually fail)
          for (let retry = 0; retry < RETRY && ssdp && resolve; retry++) {
            await ssdp.discover(URN_IGD, TIMEOUT);
          }
          if (ssdp) {
            ssdp.off('ssdp:search-response', search);
            ssdp.off(`discover:${URN_IGD}`, discover);
          }
          if (resolve) {
            resolve(null);
          }
        });
      }
      if (this._WANIPConnectionURL) {
        const IP_ADDR_REGEXP = /.*<NewExternalIPAddress>(.*)<\/NewExternalIPAddress>.*/;
        const answer = await this._sendRequest(this._WANIPConnectionURL, URN_WAN, 'GetExternalIPAddress');
        const ip = answer.replace(IP_ADDR_REGEXP, "$1");
        if (ip) {
          return ip;
        }
        // Dont cache the WAN URL if we fail to get the external ip address
        this._WANIPConnectionURL = null;
      }
    }
    return null;
  },

  _sendRequest: async function(url, service, action, args) {
    return new Promise((resolve) => {
      args = args || [];
      const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${args.map(arg => '<' + arg[0] + '>' + (arg.length === 1 ? '' : arg[1]) + '</' + arg[0] + '>')}</u:${action}></s:Body></s:Envelope>`;
      const req = HTTP.request(url, {
        method: 'POST',
        headers: {
          'Content-Length': body.length,
          'Content-Type': 'text/xml; charset="utf-8"',
          'Connection': 'close',
          'SOAPAction': JSON.stringify(`${service}#${action}`)
        }
      }, (res) => {
        let xml = '';
        res.on('data', (chunk) => {
          xml += chunk.toString();
        });
        res.on('end', () => {
          resolve(xml.replace(/[\n\r]/g, ''));
        });
      });
      req.write(body);
      req.end();
    });
  }

};

module.exports = UPNP;
