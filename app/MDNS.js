const DnsPacket = require('dns-packet');
const Dgram = require('dgram');

const MCAST_ADDRESS = '224.0.0.251';
const PORT = 5353;
const SERVICES = '_services._dns-sd._udp';

function eq(a, b) {
  return a.localeCompare(b, 'en', { sensitivity: 'base' }) == 0;
}

function MDNS() {
  this._network = null;
  this._records = [];
}

MDNS.prototype = {

  start: async function(config) {
    this._network = config.network;
    await this._create(config.ipaddress);
  },

  stop: async function() {
    if (this._socket) {
      await Promise.all(this._records.map((rec) => {
        return this.removeRecord(rec);
      }));
      this._socket.close();
      this._socket = null;
    }
  },

  addRecord: async function(rec) {
    const idx = this._records.findIndex(r => eq(r.hostname, rec.hostname) && eq(r.service, rec.service));
    if (idx !== -1) {
      const orec = this._records.splice(idx, 1);
      await this._unannounce(orec[0]);
    }
    this._records.push(rec);
    await this._announce(rec);
    return rec;
  },

  removeRecord: async function(rec) {
    const idx = this._records.findIndex(r => eq(r.hostname, rec.hostname) && eq(r.service, rec.service));
    if (idx !== -1) {
      const orec = this._records.splice(idx, 1);
      await this._unannounce(orec[0]);
    }
  },

  _create: async function(ip) {
    return new Promise((resolve) => {
      this._socket = Dgram.createSocket({
        type: 'udp4',
        reuseAddr: true
      }, (msg, rinfo) => {
        this._incoming(msg);
      });
      this._socket.bind(PORT, MCAST_ADDRESS, () => {
        this._socket.setMulticastTTL(255);
        this._socket.setMulticastLoopback(false);
        this._socket.addMembership(MCAST_ADDRESS, ip);
        this._socket.setMulticastInterface(ip);
        resolve();
      });
    });
  },

  _incoming: function(msg) {
    const pkt = DnsPacket.decode(msg);
    if (pkt.type === 'query') {
      pkt.questions.forEach((q) => {
        if (q.name.toLowerCase().startsWith(SERVICES)) {
          const domain = q.name.split('.').slice(-1);
          this._answer(Object.values(this._records.reduce((acc, rec) => {
            if (eq(rec.domainname, domain)) {
              acc[`${rec.service}.${rec.domainname}`] = { name: `${SERVICES}.${domain}`, type: 'PTR', ttl: 4500, data: `${rec.service}.${rec.domainname}` };
            }
            return acc;
          }, {})))
        }
        else {
          const srec = this._records.find(rec => eq(q.name, `${rec.hostname}.${rec.service}.${rec.domainname}`));
          if (srec) {
            this._answer([
              { name: q.name, type: 'SRV', data: { priority: 0, weight: 0, port: srec.port, target: `${srec.hostname}.${srec.domainname}` }},
              { name: q.name, type: 'TXT', data: srec.data || [] }
            ]);
          }
          else {
            const arec = this._records.find(rec => eq(q.name, `${rec.hostname}.${rec.domainname}`));
            if (arec) {
              this._answer([{ name: q.name, type: 'A', data: arec.ip }]);
            }
            else {
              const panswers = this._records.reduce((acc, rec) => {
                if (eq(q.name, `${rec.service}.${rec.domainname}`)) {
                  acc.push({ name: `${rec.service}.${rec.domainname}`, type: 'PTR', data: `${rec.hostname}.${rec.service}.${rec.domainname}` });
                }
                return acc;
              }, []);
              if (panswers.length) {
                this._answer(panswers);
              }
            }
          }
        }
      });
    }
  },

  _announce: async function(rec) {
    await this._answer([
      { name: `${rec.service}.${rec.domainname}`,                 type: 'PTR', data: `${rec.hostname}.${rec.service}.${rec.domainname}` },
      { name: `${rec.hostname}.${rec.service}.${rec.domainname}`, type: 'SRV', data: { priority: 0, weight: 0, port: rec.port, target: `${rec.hostname}.${rec.domainname}` }},
      { name: `${rec.hostname}.${rec.service}.${rec.domainname}`, type: 'TXT', data: rec.txt },
      { name: `${rec.hostname}.${rec.domainname}`,                type: 'A',   data: rec.ip }
    ]);
  },

  _unannounce: async function(rec) {
    await this._answer([
      { name: `${rec.service}.${rec.domainname}`,                 ttl: 0, type: 'PTR', data: `${rec.hostname}.${rec.service}.${rec.domainname}` },
      { name: `${rec.hostname}.${rec.service}.${rec.domainname}`, ttl: 0, type: 'SRV', data: { priority: 0, weight: 0, port: rec.port, target: `${rec.hostname}.${rec.domainname}` }},
      { name: `${rec.hostname}.${rec.service}.${rec.domainname}`, ttl: 0, type: 'TXT', data: rec.txt },
      { name: `${rec.hostname}.${rec.domainname}`,                ttl: 0, type: 'A',   data: rec.ip }
    ]);
  },

  _answer: async function(answers) {
    //console.log(answers);
    if (answers.length) {
      return new Promise((resolve) => {
        const msg = DnsPacket.encode({
          type: 'response',
          questions: [],
          authorities: [],
          additionals: [],
          answers: answers.map(answer => Object.assign({ class: 'IN', flush: false, ttl: 120 }, answer))
        });
        this._socket.send(msg, 0, msg.length, PORT, MCAST_ADDRESS, () => {
          resolve(true);
        });
      });
    }
    else {
      return false;
    }
  }

};

const _mdns = new MDNS();

module.exports = {
  getInstance: function() {
    return _mdns;
  }
}
