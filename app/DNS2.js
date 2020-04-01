const UDP = require('dgram');
const DnsPkt = require('dns-packet');

const SYSTEM_DNS_OFFSET = 10;
const REGEXP_PTR_IP4 = /^(.*)\.(.*)\.(.*)\.(.*).in-addr.arpa/;

const LocalDNS = {

  _ttl: 60,
  _hostname2ip4: {},
  _hostname2ip6: {},
  _ip2localname: {},
  _ip2globalname: {},
  _domainName: '',

  query: async function(request, response, rinfo) {
    switch (request.questions[0].type) {
      case 'A':
      {
        const fullname = request.questions[0].name;
        const name = fullname.split('.');
        if (name.length === 2 && name[1].toLowerCase() === this._domainName) {
          const ip = this._hostname2ip4[name[0].toLowerCase()];
          if (ip) {
            response.answers.push(
              { name: fullname,  ttl: this._ttl, type: 'A', data: ip }
            );
            const ip6 = this._hostname2ip6[name[0].toLowerCase()];
            if (ip6) {
              response.additionals.push(
                { name: fullname, ttl: this._ttl, type: 'AAAA', data: ip6 }
              );
            }
            response.flags |= DnsPkt.AUTHORITATIVE_ANSWER | DnsPkt.RECURSION_AVAILABLE;
            return true;
          }
        }
        break;
      }
      case 'AAAA':
      {
        const fullname = request.questions[0].name;
        const name = fullname.split('.');
        if (name.length === 2 && name[1].toLowerCase() === this._domainName) {
          const ip6 = this._hostname2ip6[name[0].toLowerCase()];
          if (ip6) {
            response.answers.push(
              { name: fullname, ttl: this._ttl, type: 'AAAA', data: ip6 }
            );
            const ip = this._hostname2ip4[name[0].toLowerCase()];
            if (ip) {
              response.additionals.push(
                { name: fullname, ttl: this._ttl, type: 'A', data: ip }
              );
            }
            response.flags = DnsPkt.AUTHORITATIVE_ANSWER | DnsPkt.RECURSION_AVAILABLE;
            return true;
          }
        }
        break;
      }
      case 'PTR':
      {
        const name = request.questions[0].name;
        const m4 = REGEXP_PTR_IP4.exec(name.toLowerCase());
        if (m4) {
          const ip = `${m4[4]}.${m4[3]}.${m4[2]}.${m4[1]}`;
          const localname = this._ip2localname[ip];
          if (localname) {
            response.answers.push(
              { name: name, ttl: this._ttl, type: 'CNAME', data: `${localname}.${this._domainName}` }
            );
            response.flags = DnsPkt.AUTHORITATIVE_ANSWER | DnsPkt.RECURSION_AVAILABLE;
            return true;
          }
        }
        break;
      }
      case 'CNAME':
      case 'MX':
      case 'NS':
      case 'SOA':
      case 'SRV':
      case 'TXT':
      case 'ANY':
      case 'NAPTR':
      default:
        break;
    }
    return false;
  },

  setDomainName: function(name) {
    this._domainName = name;
  },

  registerHost: function(localname, globalname, ip, ip6) {
    const kLocalname = localname.toLowerCase();
    const kGlobalname = localname.toLowerCase();
    this._hostname2ip4[kLocalname] = ip;
    this._hostname2ip4[kGlobalname] = ip;
    this._ip2localname[ip] = localname;
    this._ip2globalname[ip] = globalname;
    if (ip6) {
      this._hostname2ip6[kLocalname] = ip6;
      this._hostname2ip6[kGlobalname] = ip6;
      this._ip2localname[ip6] = localname;
      this._ip2globalname[ip6] = globalname;
    }
  },

  unregisterHost: function(localname) {
    const kLocalname = localname.toLowerCase();
    const ip = this._hostname2ip4[kLocalname];
    const ip6 = this._hostname2ip6[kLocalname];
    const kGlobalname = (this._ip2localname[ip] || '').toLowerCase();

    delete this._hostname2ip4[kLocalname];
    delete this._hostname2ip4[kGlobalname];
    delete this._hostname2ip6[kLocalname];
    delete this._hostname2ip6[kGlobalname];
    delete this._ip2localname[ip];
    delete this._ip2globalname[ip];
    delete this._ip2localname[ip6];
    delete this._ip2globalname[ip6];
  },
};

const CachingDNS = {

  _ttl: 60,
  A: {},
  AAAAA: {},
  CNAME: {},

  add: function(response) {
    response.answers.forEach(answer => this._addAnswer(answer));
    response.additionals.forEach(answer => this._addAnswer(answer));
  },

  _addAnswer: function(answer) {
    switch (answer.type) {
      case 'A':
      case 'AAAA':
      case 'CNAME':
      {
        const name = answer.name.toLowerCase();
        const R = this[answer.type][name] || (this[answer.type][name] = {});
        R[answer.data.toLowerCase()] = { name: answer.name, expires: Math.floor(Date.now() / 1000 + (answer.ttl || this._ttl)), data: answer.data };
        break;
      }
      default:
        break;
    }
  },

  _findAnswer: function(type, name) {
    const answers = [];
    switch (type) {
      case 'A':
      case 'AAAA':
      case 'CNAME':
      {
        const R = this[type][name.toLowerCase()];
        const now = Math.floor(Date.now() / 1000);
        if (R) {
          for (let key in R) {
            const rec = R[key];
            if (rec.expires > now) {
              answers.push({ name: rec.name, type: type, ttl: rec.expires - now, data: rec.data });
            }
            else {
              delete R[key];
            }
          }
        }
        break;
      }
      default:
        break;
    }
    return answers;
  },

  query: async function(request, response, rinfo) {
    const question = request.questions[0];
    switch (question.type) {
      case 'A':
      {
        // Look for a cached A record
        const a = this._findAnswer('A', question.name);
        if (a.length) {
          response.answers.push.apply(response.answers, a);
          response.flags = DnsPkt.RECURSION_AVAILABLE;
          return true;
        }
        // If that fails, look for a CNAME
        const cname = this._findAnswer('CNAME', question.name);
        if (cname.length) {
          response.answers.push.apply(response.answers, cname);
          // See if we have a cached A for the CNAME
          const ac = this._findAnswer('A', cname[0].data);
          if (ac.length) {
            response.answers.push.apply(response.answers, ac);
          }
          response.flags = DnsPkt.RECURSION_AVAILABLE;
          return true;
        }
        break;
      }
      case 'CNAME':
      {
        const cname = this._findAnswer('CNAME', question.name);
        if (cname.length) {
          response.answers.push.apply(response.answers, a);
          // See if we have a cached A/AAAA for the CNAME
          const a = this._findAnswer('A', cname[0].data);
          if (a.length) {
            response.additionals.push.apply(response.additionals, cname);
          }
          const aaaa = this._findAnswer('AAAA', cname[0].data);
          if (aaaa.length) {
            response.additionals.push.apply(response.additionals, aaaa);
          }
          response.flags = DnsPkt.RECURSION_AVAILABLE;
          return true;
        }
        break;
      }
      default:
        break;
    }
    return false;
  }

};

const ProxyDNS = function(resolve, port, timeout) {
  this._address = resolve;
  this._port = port;
  this._timeout = timeout;
  this._pending = {};
}

ProxyDNS.prototype = {

  start: async function() {
    return new Promise((resolve, reject) => {
      this._socket = UDP.createSocket('udp4');
      this._socket.bind();
      this._socket.once('error', () => reject(new Error()));
      this._socket.once('listening', () => {
        this._socket.on('message', (message, { port, address }) => {
          if (message.length < 2 || address !== this._address || port !== this._port) {
            return;
          }
          const id = message.readUInt16BE(0);
          const pending = this._pending[id];
          if (pending) {
            delete this._pending[id];
            clearTimeout(pending.timeout);
            pending.callback(message);
          }
        });
        resolve();
      });
    });
  },

  stop: function() {
    this._socket.close();
  },

  query: async function(request, response, rinfo) {
    return new Promise((resolve, reject) => {
      try {
        while (this._pending[request.id]) {
          request.id = Math.floor(Math.random() * 65536);
        }
        this._pending[request.id] = {
          callback: (message) => {
            const pkt = DnsPkt.decode(message);
            response.flags = pkt.flags;
            response.answers = pkt.answers;
            response.additionals = pkt.additionals;
            response.authorities = pkt.authorities;
            resolve(pkt.rcode === 'NOERROR');
          },
          timeout: setTimeout(() => {
            if (this._pending[request.id]) {
              delete this._pending[request.id];
              resolve(false);
            }
          }, this._timeout)
        };
        this._socket.send(DnsPkt.encode(request), this._port, this._address);
      }
      catch (e) {
        reject(e);
      }
    });
  }

};

const DNS = {

  _proxies: [
    { id: 'local', srv: LocalDNS, prio: 0 },
    { id: 'cache', srv: CachingDNS, prio: 1 },
  ],

  start: async function(port) {
    return new Promise(resolve => {
      this._udp = UDP.createSocket('udp4');
      this._udp.on('message', async (msgin, rinfo) => {
        console.log(msgin, rinfo);
        const response = {
          id: 0,
          type: 'response',
          flags: 0,
          questions: [],
          answers: [],
          authorities: [],
          additionals: []
        };
        try {
          if (msgin.length < 2) {
            throw Error('Bad length');
          }
          const request = DnsPkt.decode(msgin);
          response.id = request.id;
          response.flags = request.flags;
          response.questions = request.questions;
          console.log('request', JSON.stringify(request, null, 2));
          await this._resolve(request, response, rinfo);
        }
        catch (e) {
          console.log(e);
          response.flags = (response.flags & 0xF0) | 2; // SERVFAIL
        }
        console.log('response', JSON.stringify(DnsPkt.decode(DnsPkt.encode(response)), null, 2));
        this._udp.send(DnsPkt.encode(response), rinfo.port, rinfo.address, err => {
          if (err) {
            console.error(err);
          }
        });
      });
      this._udp.bind(port, resolve);
    });
  },

  setDefaultResolver: function(resolver1, resolver2) {
    this.removeDNSServer({ _id: 'global1' });
    this.removeDNSServer({ _id: 'global2' });
    if (resolver1) {
      this._addDNSProxy('global1', resolver1, 53, Number.MAX_SAFE_INTEGER - 1, 5000);
    }
    if (resolver2) {
      this._addDNSProxy('global2', resolver2, 53, Number.MAX_SAFE_INTEGER, 5000);
    }
  },

  addDNSServer: function(args) {
    const resolve = {
      _id: args._id,
      name: args.name,
      IP4Address: args.IP4Address,
      Port: args.port || 53,
      priority: (args.options && args.options.priority) || 5,
      delay: (args.options && args.options.delay) || 0
    };
    if (resolve.delay) {
      setTimeout(() => {
        this._addDNSProxy(resolve._id, resolve.IP4Address, resolve.Port, SYSTEM_DNS_OFFSET + resolve.priority, 5000);
      }, options.delay * 1000);
    }
    else {
      this._addDNSProxy(resolve._id, resolve.IP4Address, resolve.Port, SYSTEM_DNS_OFFSET + resolve.priority, 5000);
    }
    return resolve;
  },

  _addDNSProxy: function(id, IP4Address, port, priority, timeout) {
    const proxy = new ProxyDNS(IP4Address, port, timeout);
    proxy.start().then(() => {
      this._proxies.push({ id: id, srv: proxy, prio: priority });
      this._proxies.sort((a, b) => a.prio - b.prio);
    });
  },

  removeDNSServer: function(args) {
    for (let i = 0; i < this._proxies.length; i++) {
      if (this._proxies[i].id === args._id) {
        this._proxies.splice(i, 1)[0].stop();
        break;
      }
    }
  },

  setDomainName: function(domain) {
    LocalDNS.setDomainName(domain);
  },

  registerHost: function(localname, globalname, ip, ip6) {
    LocalDNS.registerHost(localname, globalname, ip, ip6);
  },

  unregisterHost: function(localname) {
    LocalDNS.unregisterHost(localname);
  },

  _resolve: async function(request, response, rinfo) {
    const question = request.questions[0];
    if (!question) {
      throw new Error('Missing question');
    }
    for (let i = 0; i < this._proxies.length; i++) {
      const proxy = this._proxies[i];
      console.log(`Trying ${proxy.id}`);
      if (await proxy.srv.query(request, response, rinfo)) {
        // Cache answers which don't come from Local or Caching
        if (proxy.prio >= SYSTEM_DNS_OFFSET) {
          CachingDNS.add(response);
        }
        return;
      }
    }
    response.flags = (response.flags & 0xF0) | 3; // NOTFOUND
  }

};

module.exports = DNS;
