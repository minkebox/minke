const DnsPacket = require('dns-packet');
const Dgram = require('dgram');

const MCAST_ADDRESS = '224.0.0.251';
const PORT = 5353;

const SERVICES = '_services._dns-sd._udp.local';

function eq(a, b) {
  return a.localeCompare(b, 'en', { sensitivity: 'base'}) == 0;
}

const MDNS = {

  _records: [],
  _services: [],

  start: async function(config) {
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
    const nservices = {};
    this._records.forEach((r) => {
      nservices[r.service] = true;
    });
    this._services = Object.keys(nservices);

    await this._announce(rec);

    return rec;
  },

  removeRecord: async function(rec) {
    const idx = this._records.findIndex(r => eq(r.hostname, rec.hostname) && eq(r.service, rec.service));
    if (idx !== -1) {
      const orec = this._records.splice(idx, 1);
      const nservices = {};
      this._records.forEach((r) => {
        nservices[r.service] = true;
      });
      this._services = Object.keys(nservices);

      await this._unannounce(orec[0]);
    }
  },

  _create: async function(ip) {
    return new Promise((resolve) => {
      this._socket = Dgram.createSocket({
        type: 'udp4',
        reuseAddr: true
      }, (msg, rinfo) => {
        const pkt = DnsPacket.decode(msg);
        if (pkt.type === 'query') {
          pkt.questions.forEach((q) => {
            if (eq(q.name, SERVICES)) {
              this._answer(this._services.map((svc) => {
                return { name: SERVICES, type: 'PTR', ttl: 4500, data: `${svc}` }
              }));;
            }
            else {
              const srec = this._records.find(rec => eq(q.name, `${rec.hostname}.${rec.service}`));
              if (srec) {
                this._answer([
                  { name: q.name, type: 'SRV', data: { priority: 0, weight: 0, port: srec.port, target: `${srec.hostname}.local` }},
                  { name: q.name, type: 'TXT', data: srec.data || [] }
                ]);
              }
              else {
                const arec = this._records.find(rec => eq(q.name, `${rec.hostname}.local`));
                if (arec) {
                  this._answer([{ name: q.name, type: 'A', data: arec.ip }]);
                }
                else {
                  const panswers = this._records.reduce((acc, rec) => {
                    if (rec.service === q.name) {
                      acc.push({ name: rec.service, type: 'PTR', data: `${rec.hostname}.${rec.service}` });
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

  _announce: async function(rec) {
    // rec.hostname
    // rec.service
    // rec.ip
    // rec.port
    // rec.txt
    await this._answer([
      { name: `${rec.service}`,                 type: 'PTR', data: `${rec.hostname}.${rec.service}` },
      { name: `${rec.hostname}.${rec.service}`, type: 'SRV', data: { priority: 0, weight: 0, port: rec.port, target: `${rec.hostname}.local` }},
      { name: `${rec.hostname}.${rec.service}`, type: 'TXT', data: rec.txt },
      { name: `${rec.hostname}.local`,          type: 'A',   data: rec.ip }
    ]);
  },

  _unannounce: async function(rec) {
    // rec.hostname
    // rec.service
    // rec.ip
    // rec.port
    // rec.txt
    await this._answer([
      { name: `${rec.service}`,                 ttl: 0, type: 'PTR', data: `${rec.hostname}.${rec.service}` },
      { name: `${rec.hostname}.${rec.service}`, ttl: 0, type: 'SRV', data: { priority: 0, weight: 0, port: rec.port, target: `${rec.hostname}.local` }},
      { name: `${rec.hostname}.${rec.service}`, ttl: 0, type: 'TXT', data: rec.txt },
      { name: `${rec.hostname}.local`,          ttl: 0, type: 'A',   data: rec.ip }
    ]);
  },

  _answer: async function(answers) {
    console.log(answers);
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
