const DnsPacket = require('dns-packet');
const Dgram = require('dgram');
const OS = require('os');

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

  stop: async function() {
    if (this._socket) {
      await this._unannounce();
      this._socket.close();
      this._socket = null;
    }
  },

  update: function(config) {
    if (this._socket) {
      this._unannounce();
      this._hostname = config.hostname;
      this._announce();
    }
    else {
      this._hostname = config.hostname;
    }
  },

  _create: function() {
    this._socket = Dgram.createSocket({
      type: 'udp4',
      reuseAddr: true
    }, (msg, rinfo) => {
      const pkt = DnsPacket.decode(msg);
      if (pkt.type === 'query') {
        pkt.questions.forEach((q) => {
          switch (q.name) {
            case SERVICES:
              this._answer([{ name: SERVICES, type: 'PTR', ttl: 4500, data: HTTP }]);
              break;
            case HTTP:
              this._answer([{ name: HTTP, type: 'PTR', data: `${this._hostname}.${HTTP}` }]);
              break;
            default:
              if (q.name === `${this._hostname}.${HTTP}`) {
                this._answer([
                  { name: `${this._hostname}.${HTTP}`, type: 'SRV', data: { priority: 0, weight: 0, port: 80, target: `${this._hostname}.local` }},
                  { name: `${this._hostname}.${HTTP}`, type: 'TXT', data: [] }
                ]);
              }
              else if (q.name === `${this._hostname}.local`) {
                this._answer([{ name: `${this._hostname}.local`, type: 'A', data: this._ip }]);
              }
              break;
          }
        });
      }
    });
    this._socket.bind(PORT, MCAST_ADDRESS, () => {
      this._socket.setMulticastTTL(255);
      this._socket.setMulticastLoopback(false);
      this._socket.addMembership(MCAST_ADDRESS, this._ip);
      this._socket.setMulticastInterface(this._ip);
      this._announce();
    });
    return true;
  },

  _announce: async function() {
    await this._answer([
      { name: HTTP,                        type: 'PTR', data: `${this._hostname}.${HTTP}` },
      { name: `${this._hostname}.${HTTP}`, type: 'SRV', data: { priority: 0, weight: 0, port: 80, target: `${this._hostname}.local` }},
      { name: `${this._hostname}.${HTTP}`, type: 'TXT', data: [] },
      { name: `${this._hostname}.local`,   type: 'A',   data: this._ip }
    ]);
  },

  _unannounce: async function() {
    await this._answer([
      { name: HTTP,                        ttl: 0, type: 'PTR', data: `${this._hostname}.${HTTP}` },
      { name: `${this._hostname}.${HTTP}`, ttl: 0, type: 'SRV', data: { priority: 0, weight: 0, port: 80, target: `${this._hostname}.local` }},
      { name: `${this._hostname}.${HTTP}`, ttl: 0, type: 'TXT', data: [] },
      { name: `${this._hostname}.local`,   ttl: 0, type: 'A',   data: this._ip }
    ]);
  },

  _answer: async function(answers) {
    return new Promise((resolve) => {
      const msg = DnsPacket.encode({
        type: 'response',
        questions: [],
        authorities: [],
        additionals: [],
        answers: answers.map((answer) => {
          return Object.assign({ class: 'IN', flush: false, ttl: 120 }, answer);
        })
      });
      this._socket.send(msg, 0, msg.length, PORT, MCAST_ADDRESS, () => {
        resolve(true);
      });
    });
  }

};

module.exports = MDNS;
