const SSDP = require('node-ssdp');
const URL = require('url').URL;
const HTTP = require('http');
const XMLJS = require('xml-js');
const UUID = require('uuid/v4');
const MinkeApp = require('./MinkeApp');

const URN_WAN = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const URN_IGD = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
const TIMEOUT = 1 * 1000; // 1 second
const WAN_FAST_REFRESH = 30 * 1000; // 30 seconds
const WAN_SLOW_REFRESH = 5 * 60 * 1000; // 5 minutes
const PROXY_REFRESH = 60 * 1000; // 60 seconds
const REQ_TIMEOUT = 5 * 1000; // 5 seconds

const UPNP = {

  _uuid: '',
  _hostname: '',
  _ip: '0.0.0.0',
  _WANIPConnectionURL: null,
  _gwLocation: null,

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

    try {
      this._ssdpServer = new SSDP.Server({
        udn: `uuid:${this._uuid}`,
        ssdpSig: 'MinkeBox UPnP/1.1',
        location: `http://${this._ip}/rootDesc.xml`
      });
      this._ssdpServer.addUSN('upnp:rootdevice');
      this._ssdpServer.start();
    }
    catch (e) {
      console.error(e);
      this._ssdpServer = null;
    }

    try {
      this._ssdpClient = new SSDP.Client({});
      this._ssdpClient.on('response', (headers, statusCode, rinfo) => {
        if (statusCode === 200 && headers.ST === URN_IGD) {
          const req = HTTP.request(headers.LOCATION, {
            method: 'GET'
          }, (res) => {
            let xml = '';
            res.on('data', (chunk) => {
              xml += chunk.toString();
            });
            res.on('end', () => {
              const json = JSON.parse(XMLJS.xml2json(xml, { compact: true }));
              for (let device = json && json.root && json.root.device && json.root.device; device; device = device.deviceList && device.deviceList.device) {
                const service = device.serviceList && device.serviceList.service;
                if (service && service.serviceType && service.serviceType._text == URN_WAN) {
                  this._gwLocation = headers.LOCATION;
                  this._WANIPConnectionURL = new URL(service.controlURL._text, headers.LOCATION);
                  this._startProxy();
                  break;
                }
              }
            });
          });
          req.end();
        }
      });
      await this._ssdpClient.start();
      const wRefresh = () => {
        if (this._ssdpClient) {
          this._ssdpClient.search(URN_IGD);
        }
        this._wanRefresh = setTimeout(wRefresh, this._gwLocation ? WAN_SLOW_REFRESH : WAN_FAST_REFRESH);
      }
      wRefresh();

      // Pause for a short while to let the UPNP stuff happen
      return new Promise(resolve => setTimeout(resolve, TIMEOUT));
    }
    catch (e) {
      console.error(e);
      this._ssdpClient = null;
      this._WANIPConnectionURL = null;
    }
  },

  stop: async function() {
    if (this._wanRefresh) {
      clearTimeout(this._wanRefresh);
      this._wanRefresh = null;
    }
    if (this._proxyRefresh) {
      clearInterval(this._proxyRefresh);
      this._proxyRefresh = null;
      if (this._proxy) {
        this._proxy.stop();
        this._proxy = null;
      }
    }
    if (this._ssdpServer) {
      this._ssdpServer.stop();
      this._ssdpServer = null;
    }
    if (this._ssdpClient) {
      this._ssdpClient.stop();
      this._ssdpClient = null;
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
    return !!this._WANIPConnectionURL;
  },

  getWANLocationURL: function() {
    return this._WANIPConnectionURL;
  },

  getExternalIP: async function() {
    const WANIPConnectionURL = this.getWANLocationURL();
    if (WANIPConnectionURL) {
      const IP_ADDR_REGEXP = /.*<NewExternalIPAddress>(.*)<\/NewExternalIPAddress>.*/;
      const answer = await this._sendRequest(WANIPConnectionURL, URN_WAN, 'GetExternalIPAddress');
      const ip = answer.replace(IP_ADDR_REGEXP, "$1");
      if (ip) {
        return ip;
      }
    }
    return null;
  },

  getActivePorts: async function() {
    const WANIPConnectionURL = this.getWANLocationURL();
    if (WANIPConnectionURL) {
      const udp = await this._sendRequest(WANIPConnectionURL, URN_WAN, 'GetListOfPortMappings', [
        [ 'NewStartPort', 0 ],
        [ 'NewEndPort', 65535 ],
        [ 'NewProtocol', 'UDP' ],
        [ 'NewManage', '1' ],
        [ 'NewNumberOfPorts', 1000 ]
      ]);
      const tcp = await this._sendRequest(WANIPConnectionURL, URN_WAN, 'GetListOfPortMappings', [
        [ 'NewStartPort', 0 ],
        [ 'NewEndPort', 65535 ],
        [ 'NewProtocol', 'TCP' ],
        [ 'NewManage', '1' ],
        [ 'NewNumberOfPorts', 1000 ]
      ]);
      const ports = {};
      let m;
      for (const re = /<.*?NewExternalPort>(.*?)<\/.*?NewExternalPort>/g; m = re.exec(udp), m; ) {
        ports[m[1]] = true;
      }
      for (const re = /<.*?NewExternalPort>(.*?)<\/.*?NewExternalPort>/g; m = re.exec(tcp), m; ) {
        ports[m[1]] = true;
      }
      return Object.keys(ports).map(port => parseInt(port));
    }
    else {
      return [];
    }
  },

  _sendRequest: async function(url, service, action, args) {
    return new Promise(resolve => {
      args = args || [];
      const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${args.map(arg => '<' + arg[0] + '>' + (arg.length === 1 ? '' : arg[1]) + '</' + arg[0] + '>').join('')}</u:${action}></s:Body></s:Envelope>`;
      const req = HTTP.request(url, {
        method: 'POST',
        headers: {
          'Content-Length': body.length,
          'Content-Type': 'text/xml; charset="utf-8"',
          'Connection': 'close',
          'SOAPAction': JSON.stringify(`${service}#${action}`)
        },
        timeout: REQ_TIMEOUT
      }, res => {
        let xml = '';
        res.on('data', chunk => {
          xml += chunk.toString();
        });
        res.on('end', () => {
          resolve(xml.replace(/[\n\r]/g, ''));
        });
        res.on('error', () => {
          resolve(xml.replace(/[\n\r]/g, ''));
        });
      });
      req.on('error', () => {
        resolve('');
      });
      req.write(body);
      req.end();
    });
  },

  _startProxy: async function() {
    if (!this._proxyRefresh &&  (MinkeApp._network || { network: {} }).network.name === 'wlan0') {
      const uuid = UUID();
      const run = async () => {
        if (this._proxy) {
          try {
            this._proxy.stop();
          }
          catch (e) {
            console.error(e);
          }
        }
        this._proxy = new SSDP.Server({
          udn: `uuid:${uuid}`,
          ssdpSig: 'MinkeBox IGD Proxy UPnP/1.1',
          location: () => {
            return this._gwLocation
          }
        });
        this._proxy.addUSN(URN_IGD);
        await this._proxy.start();
      }
      this._proxyRefresh = setInterval(run, PROXY_REFRESH);
      await run();
      console.log('UPNP Proxy started', this._gwLocation);
    }
  }

};

module.exports = UPNP;
