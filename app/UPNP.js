const SSDP = require('@achingbrain/ssdp');
const SSDPcache = require('@achingbrain/ssdp/lib/cache');
const URL = require('url').URL;
const HTTP = require('http');

const URN_WAN= 'urn:schemas-upnp-org:service:WANIPConnection:1';
const URN_IGD = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
const TIMEOUT = 1 * 1000;
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

    this._clearCache();
    this._WANIPConnectionURL = null;

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

    this._wanRefresh = setInterval(() => {
      this._WANIPConnectionURL = null;
    }, 60 * 1000);
  },

  stop: async function() {
    if (this._wanRefresh) {
      clearInterval(this._wanRefresh);
      this._wanRefresh = null;
    }
    if (ssdp) {
      await ssdp.stop();
      ssdp = null;
    }
  },

  restart: async function() {
    if (ssdp) {
      await this.stop();
      await this.start({
        uuid: this._uuid,
        hostname: this._hostname,
        ipaddress: this._ip,
        port: this._port
      });
    }
  },

  update: function(config) {
    this._hostname = config.hostname;
  },

  available: function() {
    this.getWANLocationURL();
    return !!this._WANIPConnectionURL;
  },

  getWANLocationURL: async function() {
    if (!this._WANIPConnectionURL) {
      if (!ssdp) {
        return null;
      }

      let location = null;

      function extractLocation(res) {
        if (res.ST === URN_IGD) {
          location = new URL(res.LOCATION);
        }
      }

      function extractWANIPConnectionURL(service) {
        if (location) {
          for (let ptr = service.details; ptr && ptr.device; ptr = ptr.device.deviceList) {
            const list = ptr.device.serviceList;
            if (list && list.service && list.service.serviceType === URN_WAN) {
              return new URL(list.service.controlURL, location.origin);
            }
          }
        }
        return null;
      }

      ssdp.on('ssdp:search-response', extractLocation);

      this._clearCache();

      for (let retry = 1; retry < RETRY && ssdp && !this._WANIPConnectionURL; retry++) {
        const services = await ssdp.discover(URN_IGD, TIMEOUT * retry);
        services.forEach((service) => {
          if (!this._WANIPConnectionURL) {
            this._WANIPConnectionURL = extractWANIPConnectionURL(service);
          }
        });
      }

      if (ssdp) {
        ssdp.off('ssdp:search-response', extractLocation);
      }
    }
    return this._WANIPConnectionURL;
  },

  getExternalIP: async function() {
    const WANIPConnectionURL = await this.getWANLocationURL();
    if (WANIPConnectionURL) {
      const IP_ADDR_REGEXP = /.*<NewExternalIPAddress>(.*)<\/NewExternalIPAddress>.*/;
      const answer = await this._sendRequest(WANIPConnectionURL, URN_WAN, 'GetExternalIPAddress');
      const ip = answer.replace(IP_ADDR_REGEXP, "$1");
      if (ip) {
        return ip;
      }
    }
    this.restart();
    return null;
  },

  _clearCache: function() {
    for (let key in SSDPcache) {
      delete SSDPcache[key];
    }
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
