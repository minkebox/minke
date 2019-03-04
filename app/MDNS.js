const DnsPacket = require('dns-packet');
const Dgram = require('dgram');
const OS = require('os');

const IFACE = 'br0';
const MCAST_ADDRESS = '224.0.0.251';
const PORT = 5353;

const SERVICES = '_services._dns-sd._udp.local';
const HTTP = '_http._tcp.local';

const MDNS = {

  _hostname: 'Minke',
  _ip: '0.0.0.0',

  start: function(config) {
   
    this._hostname = config.hostname;
    this._ip = config.ipaddress;

    this._create();
  },

  stop: function() {
    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }
  },

  update: function(config) {
    this._hostname = config.hostname;
  },

  _create: function() {
    const interfaces = OS.networkInterfaces()[IFACE];
    if (!interfaces) {
      return false;
    }
    const interface = interfaces.find(i => i.family === 'IPv4');
    if (!interface) {
      return false;
    }
    this._socket = Dgram.createSocket({
      type: 'udp4',
      reuseAddr: true
    }, (msg, rinfo) => {
      const pkt = DnsPacket.decode(msg);
      if (pkt.type === 'query') {
        pkt.questions.forEach((q) => {
          switch (q.name) {
            case SERVICES:
              this._answer([{ name: q.name, type: 'PTR', ttl: 4500, data: HTTP }]);
              break;
            case HTTP:
              this._answer([{ name: q.name, type: 'PTR', ttl: 120/*4500*/, data: `${this._hostname}.${q.name}` }]);
              break;
            default:
              if (q.name === `${this._hostname}.${HTTP}`) {
                this._answer([
                  { name: q.name, type: 'SRV', ttl: 120,  data: { priority: 0, weight: 0, port: 80, target: `${this._hostname}.local` }},
                  { name: q.name, type: 'TXT', ttl: 120/*4500*/, data: [] },
                  { name: q.name, type: 'A',   ttl: 120,  data: this._ip }
                ]);
              }
              else if (q.name === `${this._hostname}.local`) {
                this._answer([{ name: q.name, type: 'A', ttl: 120, data: this._ip }]);
              }
              break;
          }
        });
      }
    });
    this._socket.bind(PORT, MCAST_ADDRESS, () => {
      this._socket.setMulticastTTL(255);
      this._socket.setMulticastLoopback(false);
      this._socket.addMembership(MCAST_ADDRESS, interface.address);
      this._socket.setMulticastInterface(interface.address);
    });
    return true;
  },

  _answer: function(answers) {
    const msg = DnsPacket.encode({
      type: 'response',
      questions: [],
      authorities: [],
      additionals: [],
      answers: answers.map((answer) => {
        return Object.assign({ class: 'IN', flush: false }, answer);
      })
    });
    this._socket.send(msg, 0, msg.length, PORT, MCAST_ADDRESS);
  }

};

module.exports = MDNS;
