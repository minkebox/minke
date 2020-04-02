const UDP = require('dgram');
const ChildProcess = require('child_process');
const FS = require('fs');
const DnsPkt = require('dns-packet');
const Network = require('./Network');
const Database = require('./Database');
const MDNS = require('./MDNS');

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const HOSTNAME_FILE = `${ETC}hostname`;
const HOSTNAME = '/bin/hostname';
const SYSTEM_DNS_OFFSET = 10;
const DNS_NETWORK = (SYSTEM ? 'dns0' : 'eth1');
const REGEXP_PTR_IP4 = /^(.*)\.(.*)\.(.*)\.(.*)\.in-addr\.arpa/;
const REGEXP_PTR_IP6 = /^(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.ip6\.arpa/;

//
// PrivateDNS provides mappings for locally hosted services.
//
const PrivateDNS = {

  _ttl: 600, // 10 minutes
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
        const m4 = REGEXP_PTR_IP4.exec(name);
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
        else {
          const m6 = REGEXP_PTR_IP6.exec(name);
          if (m6) {
            const ip6 = `${m6[32]}${m6[31]}${m6[30]}${m6[29]}:${m6[28]}${m6[27]}${m6[26]}${m6[25]}:${m6[24]}${m6[23]}${m6[22]}${m6[21]}:${m6[20]}${m6[19]}${m6[18]}${m6[17]}:${m6[16]}${m6[15]}${m6[14]}${m6[13]}:${m6[12]}${m6[11]}${m6[10]}${m6[9]}:${m6[8]}${m6[7]}${m6[6]}${m6[5]}:${m6[4]}${m6[3]}${m6[2]}${m6[1]}`;
            const localname = this._ip2localname[ip6];
            if (localname) {
              response.answers.push(
                { name: name, ttl: this._ttl, type: 'CNAME', data: `${localname}.${this._domainName}` }
              );
              response.flags = DnsPkt.AUTHORITATIVE_ANSWER | DnsPkt.RECURSION_AVAILABLE;
              return true;
            }
          }
        }
        break;
      }
      default:
        break;
    }
    return false;
  },

  setDomainName: function(name) {
    this._domainName = name.toLowerCase();
  },

  registerHost: function(localname, globalname, ip, ip6) {
    const kLocalname = localname.toLowerCase();
    this._hostname2ip4[kLocalname] = ip;
    this._ip2localname[ip] = localname;
    if (ip6) {
      this._hostname2ip6[kLocalname] = ip6;
      this._ip2localname[ip6] = localname;
    }
    if (globalname) {
      const kGlobalname = globalname.toLowerCase();
      this._hostname2ip4[kGlobalname] = ip;
      this._ip2globalname[ip] = globalname;
      if (ip6) {
        this._hostname2ip6[kGlobalname] = ip6;
        this._ip2globalname[ip6] = globalname;
      }
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

//
// CachingDNS caches lookups from external DNS servers to speed things up.
//
const CachingDNS = {

  _defaultTTL: 600, // 10 minutes
  _maxTTL: 3600, // 1 hour
  _qHighWater: 1000,
  _qLowWater: 900,

  _q: [],
  _qTrim: null,

  _cache: {
    A: {},
    AAAA: {},
    CNAME: {}
  },

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
        const R = this._cache[answer.type][name] || (this._cache[answer.type][name] = {});
        const key = answer.data.toLowerCase();
        const rec = { name: answer.name, type: answer.type, expires: Math.floor(Date.now() / 1000 + Math.min(this._maxTTL, (answer.ttl || this._defaultTTL))), data: answer.data };
        if (R[key]) {
          R[key].expires = rec.expires;
        }
        else {
          R[key] = rec;
          this._q.push(rec);
        }
        break;
      }
      default:
        break;
    }

    if (this._q.length > this._qHighWater && !this._qTrim) {
      this._qTrim = setTimeout(() => {
        this._trimAnswers();
      }, 0);
    }
  },

  _findAnswer: function(type, name) {
    const answers = [];
    switch (type) {
      case 'A':
      case 'AAAA':
      case 'CNAME':
      {
        const R = this._cache[type][name.toLowerCase()];
        const now = Math.floor(Date.now() / 1000);
        if (R) {
          for (let key in R) {
            const rec = R[key];
            if (rec.expires > now) {
              answers.push({ name: rec.name, type: rec.type, ttl: rec.expires - now, data: rec.data });
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

  _trimAnswers: function() {
    const diff = this._q.length - this._qLowWater;
    //console.log(`Flushing ${diff}`)
    if (diff > 0) {
      this._q.sort((a, b) => a.expires - b.expires);
      const candidates = this._q.splice(0, diff);
      candidates.forEach(candidate => {
        const name = candidate.name.toLowerCase();
        const R = this._cache[candidate.type][name];
        if (R) {
          const key = candidate.data.toLowerCase();
          if (R[key]) {
            delete R[key];
          }
          else {
            console.error('Missing trim entry', candidate);
          }
          if (Object.keys(R).length === 0) {
            delete this._cache[candidate.type][name];
          }
        }
        else {
          console.error('Missing trim list', candidate);
        }
      });
    }
    this._qTrim = null;
  },

  flush: function() {
    if (this._qTrim) {
      clearTimeout(this._qTrim);
      this._qTrim = null;
    }
    this._q = [];
    for (let key in this._cache) {
      this._cache[key] = {};
    }
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
          // See if we have a cached A for the CNAME
          const ac = this._findAnswer('A', cname[0].data);
          if (ac.length) {
            response.answers.push.apply(response.answers, cname);
            response.answers.push.apply(response.answers, ac);
            response.flags = DnsPkt.RECURSION_AVAILABLE;
            return true;
          }
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

//
// MulticastDNS
//
const MulticastDNS = {

  _defaultTTL: 60, // 1 minute

  query: async function(request, response, rinfo) {
    const question = request.questions[0];
    switch (question.type) {
      case 'A':
      {
        const name = question.name.split('.');
        if (name[1] !== 'local') {
          break;
        }
        const ip = MDNS.getAddrByHostname(name[0]);
        if (!ip) {
          break;
        }
        response.answers.push({ name: question.name, type: 'A', ttl: this._defaultTTL, data: ip });
        return true;
      }
      default:
        break;
    }
    return false;
  }

};

//
// GlobalDNS proxies DNS servers on the Internet.
//
const GlobalDNS = function(resolve, port, timeout) {
  this._address = resolve;
  this._port = port;
  this._timeout = timeout;
  this._pending = {};
}

GlobalDNS.prototype = {

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
    // Dont send a query back to a server it came from.
    if (rinfo.address === this._address) {
      return false;
    }
    return new Promise((resolve, reject) => {
      try {
        while (this._pending[request.id]) {
          request.id = Math.floor(Math.random() * 65536);
        }
        this._pending[request.id] = {
          callback: (message) => {
            const pkt = DnsPkt.decode(message);
            if (pkt.rcode === 'NOERROR') {
              response.flags = pkt.flags;
              response.answers = pkt.answers;
              response.additionals = pkt.additionals;
              response.authorities = pkt.authorities;
              resolve(true);
            }
            else {
              resolve(false);
            }
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

const LocalDNSSingleton = {

  _qHighWater: 50,
  _qLowWater: 20,
  _forwardCache: {},
  _backwardCache: {},
  _pending: {},

  start: async function() {
    this._network = await Network.getDNSNetwork();
    const subnet = this._network.info.IPAM.Config[0].Subnet;
    const base = subnet.split('/')[0].split('.');
    this._bits = 24;
    this._dev = DNS_NETWORK;

    const state = (await Database.getConfig('localdns')) || { map: [] };
    for (let i = 0; i < state.map.length; i++) {
      const newEntry = {
        socket: null,
        lastUse: Date.now(),
        address: state.map[i].address,
        dnsAddress: state.map[i].dnsAddress
      };
      this._forwardCache[newEntry.address] = newEntry;
      this._backwardCache[newEntry.dnsAddress] = newEntry;
    }

    this._available = [];
    for (let i = 254; i > 32; i--) {
      const dnsAddress = `${base[0]}.${base[1]}.${base[2]}.${i}`;
      if (!this._backwardCache[dnsAddress]) {
        this._available.push(dnsAddress);
      }
    }
  },

  stop: async function() {
    const state = {
      _id: 'localdns',
      map: []
    };
    for (let address in this._forwardCache) {
      state.map.push({ address: address, dnsAddress: this._forwardCache[address].dnsAddress });
    }
    await Database.saveConfig(state);
  },

  _allocAddress: function(address) {
    const daddress = this._available.shift();
    if (this._available.length < this._qLowWater && !this._qPrune) {
      this._qPrune = setTimeout(() => {
        this._pruneAddresses();
      }, 0);
    }
    const newEntry = {
      socket: null,
      lastUse: Date.now(),
      address: address,
      dnsAddress: daddress
    };
    this._forwardCache[newEntry.address] = newEntry;
    this._backwardCache[newEntry.dnsAddress] = newEntry;
    return newEntry;
  },

  _releaseAddress: function(address) {
    if (this._available.indexOf(address) !== -1) {
      console.error('Releasing address again', address);
    }
    else {
      this._available.push(address);
    }
  },

  _bindInterface: function(address) {
    ChildProcess.spawnSync('/sbin/ip', [ 'addr', 'add', `${address}/${this._bits}`, 'dev', this._dev ]);
  },

  _unbindInterface: function(address) {
    ChildProcess.spawnSync('/sbin/ip', [ 'addr', 'del', `${address}/${this._bits}`, 'dev', this._dev ]);
  },

  _pruneAddresses: function() {
    const diff = this._qHighWater - this._available.length;
    if (diff > 0) {
      const active = Object.values(this._forwardCache);
      active.sort((a, b) => a.lastUse - b.lastUse);
      for (let i = 0; i < diff; i++) {
        const entry = active[i];
        delete this._forwardCache[entry.address];
        delete this._backwardCache[entry.daddress];
        this._unbindInterface(entry.daddress);
        this._releaseAddress(entry.daddress);
        entry.socket.close();
      }
    }
    this._qPrune = null;
  },

  getSocket: async function(rinfo) {
    const entry = this._forwardCache[rinfo.address] || this._allocAddress(rinfo.address);
    if (entry.socket) {
      entry.lastUse = Date.now();
      return entry.socket;
    }
    return new Promise((resolve, reject) => {
      entry.socket = UDP.createSocket('udp4');
      this._bindInterface(entry.dnsAddress);
      entry.socket.bind(0, entry.dnsAddress);
      entry.socket.once('error', () => reject(new Error()));
      entry.socket.once('listening', () => {
        entry.socket.on('message', (message, { port, address }) => {
          if (message.length < 2) {
            return;
          }
          const id = message.readUInt16BE(0);
          const pending = this._pending[id];
          if (pending && pending.port === port && pending.address === address) {
            delete this._pending[id];
            clearTimeout(pending.timeout);
            pending.callback(message);
          }
        });
        resolve(entry.socket);
      });
    });
  },

  query: async function(request, response, rinfo, tinfo) {
    return new Promise((resolve, reject) => {
      try {
        while (this._pending[request.id]) {
          request.id = Math.floor(Math.random() * 65536);
        }
        this._pending[request.id] = {
          port: tinfo._port,
          address: tinfo._address,
          callback: (message) => {
            const pkt = DnsPkt.decode(message);
            if (pkt.rcode === 'NOERROR') {
              response.flags = pkt.flags;
              response.answers = pkt.answers;
              response.additionals = pkt.additionals;
              response.authorities = pkt.authorities;
              resolve(true);
            }
            else {
              resolve(false);
            }
          },
          timeout: setTimeout(() => {
            if (this._pending[request.id]) {
              delete this._pending[request.id];
              resolve(false);
            }
          }, tinfo._timeout)
        };
        this.getSocket(rinfo).then(socket => socket.send(DnsPkt.encode(request), tinfo._port, tinfo._address));
      }
      catch (e) {
        reject(e);
      }
    });
  },

  translateDNSNetworkAddress: function(address) {
    const entry = this._backwardCache[address];
    if (entry) {
      return entry.address;
    }
    return null;
  }
}

//
// LocalDNS proxies DNS servers on the DNS network.
//
const LocalDNS = function(resolve, port, timeout) {
  this._address = resolve;
  this._port = port;
  this._timeout = timeout;
}

LocalDNS.prototype = {

  start: async function() {
  },

  stop: function() {
  },

  query: async function(request, response, rinfo) {
    // Dont send a query back to a server it came from.
    if (rinfo.address === this._address) {
      return false;
    }
    return await LocalDNSSingleton.query(request, response, rinfo, this);
  }
};

//
// MapDNS maps addresses which are from the DNS network back to their original values, does the lookup,
// and then send the answers back to the original caller.
//
const MapDNS = {

  query: async function(request, response, rinfo) {
    const qname = request.questions[0].name;
    if (request.questions[0].type !== 'PTR') {
      return false;
    }
    const m4 = REGEXP_PTR_IP4.exec(qname);
    if (!m4) {
      return false;
    }
    const address = LocalDNSSingleton.translateDNSNetworkAddress(`${m4[4]}.${m4[3]}.${m4[2]}.${m4[1]}`);
    if (!address) {
      return false;
    }
    const i4 = address.split('.');
    if (i4.length !== 4) {
      return false;
    }
    const nname = `${i4[3]}.${i4[2]}.${i4[1]}.${i4[0]}.in-addr.arpa`;
    request.questions[0].name = nname;
    const success = await DNS.query(request, response, rinfo);
    if (success) {
      response.answers.forEach(answer => {
        if (answer.name === nname) {
          answer.name = qname;
        }
      });
    }
    request.questions[0].name = qname;
    return success;
  }

}


const DNS = {

  _proxies: [
    { id: 'local', srv: PrivateDNS,   prio: 0, cache: false },
    { id: 'mdns',  srv: MulticastDNS, prio: 1, cache: false },
    { id: 'map',   srv: MapDNS,       prio: 2, cache: false },
    { id: 'cache', srv: CachingDNS,   prio: 3, cache: false }
  ],

  start: async function(config) {
    this.setDomainName(config.domainname);
    this.setHostname(config.hostname, config.ip);
    this.setDefaultResolver(config.resolvers[0], config.resolvers[1]);

    await new Promise(resolve => {
      this._udp = UDP.createSocket({
        type: 'udp4',
        reuseAddr: true
      });
      this._udp.on('message', async (msgin, rinfo) => {
        //console.log(msgin, rinfo);
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
          //console.log('request', JSON.stringify(request, null, 2));
          await this.query(request, response, rinfo);
        }
        catch (e) {
          console.error(e);
          response.flags = (response.flags & 0xF0) | 2; // SERVFAIL
        }
        //console.log('response', JSON.stringify(DnsPkt.decode(DnsPkt.encode(response)), null, 2));
        this._udp.send(DnsPkt.encode(response), rinfo.port, rinfo.address, err => {
          if (err) {
            console.error(err);
          }
        });
      });
      this._udp.on('error', (e) => console.error(e));
      this._udp.bind(config.port, resolve);
    });
    await LocalDNSSingleton.start();
  },

  stop: async function() {
    this._udp.close();
    await LocalDNSSingleton.stop();
  },

  setDefaultResolver: function(resolver1, resolver2) {
    this.removeDNSServer({ _id: 'global1' });
    this.removeDNSServer({ _id: 'global2' });
    if (resolver1) {
      this._addDNSProxy('global1', new GlobalDNS(resolver1, 53, 5000), Number.MAX_SAFE_INTEGER - 1, true);

    }
    if (resolver2) {
      this._addDNSProxy('global2', new GlobalDNS(resolver2, 53, 5000), Number.MAX_SAFE_INTEGER, true);
    }
  },

  addDNSServer: function(args) {
    const resolve = {
      _id: args._id,
      name: args.name,
      IP4Address: args.IP4Address,
      Port: args.port || 53,
      priority: (args.options && args.options.priority) || 5,
      delay: (args.options && args.options.delay) || 0,
      dnsNetwork: args.dnsNetwork,
      timeout: args.timeout || 5000
    };
    const proxy = resolve.dnsNetwork ?
      new LocalDNS(resolve.IP4Address, resolve.Port, resolve.timeout) :
      new GlobalDNS(resolve.IP4Address, resolve.Port, resolve.timeout);
    this._addDNSProxy(resolve._id, proxy, SYSTEM_DNS_OFFSET + resolve.priority, true);
    return resolve;
  },

  _addDNSProxy: function(id, proxy, priority, cache) {
    proxy.start().then(() => {
      this._proxies.push({ id: id, srv: proxy, prio: priority, cache: cache });
      this._proxies.sort((a, b) => a.prio - b.prio);
    });
    CachingDNS.flush();
  },

  removeDNSServer: function(args) {
    for (let i = 0; i < this._proxies.length; i++) {
      if (this._proxies[i].id === args._id) {
        this._proxies.splice(i, 1)[0].srv.stop();
        CachingDNS.flush();
        break;
      }
    }
  },

  setHostname: function(hostname, ip) {
    hostname = hostname || 'MinkeBox';
    if (!DEBUG) {
      FS.writeFileSync(HOSTNAME_FILE, `${hostname}\n`);
      ChildProcess.spawnSync(HOSTNAME, [ '-F', HOSTNAME_FILE ]);
    }
    this.registerHost(hostname, null, ip, Network.getSLAACAddress());
  },

  setDomainName: function(domain) {
    PrivateDNS.setDomainName(domain);
  },

  registerHost: function(localname, globalname, ip, ip6) {
    PrivateDNS.registerHost(localname, globalname, ip, ip6);
  },

  unregisterHost: function(localname) {
    PrivateDNS.unregisterHost(localname);
  },

  query: async function(request, response, rinfo) {
    const question = request.questions[0];
    if (!question) {
      throw new Error('Missing question');
    }
    for (let i = 0; i < this._proxies.length; i++) {
      const proxy = this._proxies[i];
      //console.log(`Trying ${proxy.id}`);
      if (await proxy.srv.query(request, response, rinfo)) {
        if (proxy.cache) {
          CachingDNS.add(response);
        }
        return true;
      }
    }
    response.flags = (response.flags & 0xF0) | 3; // NOTFOUND
    return false;
  }

};

module.exports = DNS;
