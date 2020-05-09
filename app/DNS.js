const UDP = require('dgram');
const Net = require('net');
const ChildProcess = require('child_process');
const FS = require('fs');
const DnsPkt = require('dns-packet');
const Config = require('./Config');
const Network = require('./Network');
const Database = require('./Database');
const MDNS = require('./MDNS');

const ETC = (DEBUG ? '/tmp/' : '/etc/');
const HOSTNAME_FILE = `${ETC}hostname`;
const HOSTNAME = '/bin/hostname';
const DNS_NETWORK = (SYSTEM ? 'dns0' : 'eth1');
const REGEXP_PTR_IP4 = /^(.*)\.(.*)\.(.*)\.(.*)\.in-addr\.arpa/;
const REGEXP_PTR_IP6 = /^(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.(.*)\.ip6\.arpa/;
const GLOBAL1 = { _name: 'global1', _position: { tab: Number.MAX_SAFE_INTEGER - 1 } };
const GLOBAL2 = { _name: 'global2', _position: { tab: Number.MAX_SAFE_INTEGER } };
const MAX_SAMPLES = 128;
const STDEV_QUERY = 4;
const STDEV_FAIL = 2;

const PARALLEL_QUERY = 1;
const DEBUG_QUERY = 0;
const DEBUG_QUERY_TIMING = 0;

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
  _soa: null,

  query: async function(request, response, rinfo) {
    switch (request.questions[0].type) {
      case 'A':
      {
        const fullname = request.questions[0].name.toLowerCase();
        let name = null;
        const sname = fullname.split('.');
        if (sname.length === 1 && !this._domainName) {
          name = sname[0];
        }
        else if (sname.length === 2 && sname[1] === this._domainName) {
          name = sname[0];
        }
        else if (sname.length === 3 && Config.GLOBALDOMAIN === `.${sname[1]}.${sname[2]}`) {
          name = fullname;
        }
        if (name) {
          const ip = this._hostname2ip4[name];
          if (ip) {
            response.answers.push(
              { name: fullname,  ttl: this._ttl, type: 'A', data: ip }
            );
            const ip6 = this._hostname2ip6[name];
            if (ip6) {
              response.additionals.push(
                { name: fullname, ttl: this._ttl, type: 'AAAA', data: ip6 }
              );
            }
            if (this._soa) {
              response.authorities.push({ name: fullname, ttl: this._ttl, type: 'SOA', data: this._soa });
            }
            response.flags |= DnsPkt.AUTHORITATIVE_ANSWER;
            return true;
          }
        }
        break;
      }
      case 'AAAA':
      {
        const fullname = request.questions[0].name.toLowerCase();
        let name = null;
        const sname = fullname.split('.');
        if (sname.length === 1 && !this._domainName) {
          name = sname[0];
        }
        else if (sname.length === 2 && sname[1] === this._domainName) {
          name = sname[0];
        }
        else if (sname.length === 3 && Config.GLOBALDOMAIN === `.${sname[1]}.${sname[2]}`) {
          name = fullname;
        }
        if (name) {
          const ip6 = this._hostname2ip6[name];
          if (ip6) {
            response.answers.push(
              { name: fullname, ttl: this._ttl, type: 'AAAA', data: ip6 }
            );
            const ip = this._hostname2ip4[name];
            if (ip) {
              response.additionals.push(
                { name: fullname, ttl: this._ttl, type: 'A', data: ip }
              );
            }if (this._soa) {
              response.authorities.push({ name: fullname, ttl: this._ttl, type: 'SOA', data: this._soa });
            }
            response.flags |= DnsPkt.AUTHORITATIVE_ANSWER;
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
              { name: name, ttl: this._ttl, type: 'CNAME', data: `${localname}${this._domainName ? '.' + this._domainName : ''}` }
            );
            if (this._soa) {
              response.authorities.push({ name: name, ttl: this._ttl, type: 'SOA', data: this._soa });
            }
            response.flags |= DnsPkt.AUTHORITATIVE_ANSWER;
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
                { name: name, ttl: this._ttl, type: 'CNAME', data: `${localname}${this._domainName ? '.' + this._domainName : ''}` }
              );
              if (this._soa) {
                response.authorities.push({ name: name, ttl: this._ttl, type: 'SOA', data: this._soa });
              }
              response.flags |= DnsPkt.AUTHORITATIVE_ANSWER;
              return true;
            }
          }
        }
        break;
      }
      case 'SOA':
      {
        const fullname = request.questions[0].name;
        const name = fullname.split('.');
        if (this._soa && ((name.length === 2 && name[1].toLowerCase() === this._domainName)  || (name.length === 1 && !this._domainName))) {
          response.answers.push({ name: fullname, ttl: this._ttl, type: 'SOA', data: this._soa });
          response.flags |= DnsPkt.AUTHORITATIVE_ANSWER;
          return true;
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
    this._soa = {
      mname: this._domainName,
      rname: `dns-admin.${this._domainName}`,
      serial: 1,
      refresh: this._ttl, // Time before secondary should refresh
      retry: this._ttl, // Time before secondary should retry
      expire: this._ttl * 2, // Time secondary should consider its copy authorative
      minimum: Math.floor(this._ttl / 10) // Time to cache a negative lookup
    };
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

  lookupLocalnameIP: function(localname) {
    return this._hostname2ip4[localname.toLowerCase()];
  }
};

//
// CachingDNS caches lookups from external DNS servers to speed things up.
//
const CachingDNS = {

  _defaultTTL: 600, // 10 minutes
  _maxTTL: 3600, // 1 hour
  _defaultNegTTL: 30, // 30 seconds
  _qHighWater: 1000,
  _qLowWater: 900,

  _q: [],
  _qTrim: null,

  _cache: {
    A: {},
    AAAA: {},
    CNAME: {},
    SOA: {}
  },

  add: function(response) {
    // Dont cache truncated response
    if ((response.flags & DnsPkt.TRUNCATED_RESPONSE) !== 0) {
      return;
    }
    response.authorities.forEach(authority => this._addSOA(authority));
    response.answers.forEach(answer => this._addAnswer(answer));
    response.additionals.forEach(answer => this._addAnswer(answer));
    // If we didn't answer the question, create a negative entry
    const question = response.questions[0];
    if (!response.answers.find(answer => answer.type === question.type)) {
      this._addNegative(question)
    }
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
        const expires = Math.floor(Date.now() / 1000 + Math.min(this._maxTTL, (answer.ttl || this._defaultTTL)));
        if (R[key]) {
          R[key].expires = expires;
        }
        else {
          if (R.negative) {
            R.negative.expires = 0;
          }
          const rec = { key: key, name: answer.name, type: answer.type, expires: expires, data: answer.data };
          R[key] = rec;
          this._q.push(rec);
        }
        break;
      }
      default:
        break;
    }

    if (this._q.length > this._qHighWater && !this._qTrim) {
      this._qTrim = setTimeout(() => this._trimAnswers(), 0);
    }
  },

  _addNegative: function(question) {
    switch (question.type) {
      case 'A':
      case 'AAAA':
      case 'CNAME':
        // Need SOA information to set the TTL of the negative cache entry. If we don't
        // have it we'll use a default (which should be quite short).
        const soa = this._findSOA(question.name);
        const ttl = Math.min(this._maxTTL, (soa && soa.data.minimum ? soa.data.minimum : this._defaultNegTTL));
        const name = question.name.toLowerCase();
        const R = this._cache[question.type][name] || (this._cache[question.type][name] = {});
        const expires = Math.floor(Date.now() / 1000 + ttl);
        if (R.negative) {
          R.negative.expires = expires;
        }
        else {
          const rec = { key: 'negative', name: question.name, type: question.type, expires: expires };
          R.negative = rec;
          this._q.push(rec);
        }
        break;
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
        const R = this._cache[type][name.toLowerCase()];
        if (R) {
          const now = Math.floor(Date.now() / 1000);
          if (R.negative && R.negative.expires > now) {
            break;
          }
          for (let key in R) {
            const rec = R[key];
            if (rec.expires > now) {
              answers.push({ name: rec.name, type: rec.type, ttl: rec.expires - now, data: rec.data });
            }
          }
          break;
        }
        break;
      }
      default:
        break;
    }
    return answers.length ? answers : null;
  },

  _findNegative: function(type, name) {
    switch (type) {
      case 'A':
      case 'AAAA':
      case 'CNAME':
      {
        const R = this._cache[type][name.toLowerCase()];
        if (R && R.negative && R.negative.expires > Math.floor(Date.now() / 1000)) {
          return true;
        }
        break;
      }
    }
    return false;
  },

  _addSOA: function(soa) {
    const key = soa.name.toLowerCase();
    const entry = this._cache.SOA[key];
    if (!entry) {
      const rec = { key: 'soa', name: soa.name, type: 'SOA', expires: Math.floor(Date.now() / 1000 + Math.min(this._maxTTL, (soa.ttl || this._defaultTTL))), data: soa.data };
      this._cache.SOA[key] = { soa: rec };
      this._q.push(rec);
    }
  },

  _findSOA: function(name) {
    const sname = name.toLowerCase().split('.');
    for (let i = 0; i < sname.length; i++) {
      const soa = this._cache.SOA[sname.slice(i).join('.')];
      if (soa) {
        return soa.soa;
      }
    }
    return null;
  },

  _soa: function(name, response) {
    const soa = this._findSOA(name);
    if (soa) {
      response.authorities.push(soa);
      return true;
    }
    return false;
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
          const key = candidate.key;
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
      case 'AAAA':
      {
        // Look for a cached A/AAAA record
        const a = this._findAnswer(question.type, question.name);
        if (a) {
          response.answers.push.apply(response.answers, a);
          return true;
        }
        const cname = this._findAnswer('CNAME', question.name);
        if (cname) {
          const ac = this._findAnswer(question.type, cname[0].data);
          if (ac) {
            response.answers.push.apply(response.answers, cname);
            response.answers.push.apply(response.answers, ac);
            return true;
          }
        }

        if (!this._findNegative(question.type, question.name)) {
          return false;
        }

        const soa = this._findSOA(question.name);
        if (soa) {
          response.answers.push.apply(response.answers, cname);
          response.authorities.push(soa);
          return true;
        }

        return false;
      }
      case 'CNAME':
      {
        const cname = this._findAnswer('CNAME', question.name);
        if (cname) {
          response.answers.push.apply(response.answers, cname);
          // See if we have a cached A/AAAA for the CNAME
          const a = this._findAnswer('A', cname[0].data);
          if (a) {
            response.additionals.push.apply(response.additionals, a);
          }
          const aaaa = this._findAnswer('AAAA', cname[0].data);
          if (aaaa) {
            response.additionals.push.apply(response.additionals, aaaa);
          }
          return true;
        }

        return false;
      }
      default:
        return false;
    }
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
        if (name[name.length - 1].toLowerCase() === 'local') {
          const ip = MDNS.getAddrByHostname(name[0]);
          if (ip && name.length === 2) {
            response.answers.push({ name: question.name, type: 'A', ttl: this._defaultTTL, data: ip });
          }
          // Return true regardless of a match to stop the query process. We don't look for 'local' anywhere else.
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
// GlobalDNS proxies DNS servers on the Internet.
//
const GlobalDNS = function(address, port, timeout) {
  this._address = address;
  this._port = port;
  this._maxTimeout = timeout;
  this._samples = Array(MAX_SAMPLES).fill(this._maxTimeout);
  this._pending = {};
  // Identify local or global forwarding addresses. We don't forward local domain lookups to global addresses.
  if (/(^127\.)|(^192\.168\.)|(^10\.)|(^172\.1[6-9]\.)|(^172\.2[0-9]\.)|(^172\.3[0-1]\.)|(^::1$)|(^[fF][cCdD])/.exec(address)) {
    this._global = false;
  }
  else {
    this._global = true;
  }
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
          this._pending[id] && this._pending[id](message);
        });
        resolve();
      });
    });
  },

  stop: function() {
    this._socket.close();
  },

  getSocket: function(rinfo) {
    const start = Date.now();
    if (rinfo.tcp) {
      return (request, callback) => {
        const message = DnsPkt.encode(request);
        const msgout = Buffer.alloc(message.length + 2);
        msgout.writeUInt16BE(message.length);
        message.copy(msgout, 2);
        let timeout = setTimeout(() => {
          if (timeout) {
            this._addTimingFailure(Date.now() - start);
            timeout = null;
            callback(null);
          }
        }, this._getTimeout());
        const socket = Net.createConnection(this._port, this._address, () => {
          socket.on('error', (e) => {
            console.error(e);
            if (timeout) {
              this._addTimingFailure(Date.now() - start);
              clearTimeout(timeout);
              timeout = null;
              callback(null);
            }
            socket.destroy();
          });
          socket.on('data', (buffer) => {
            if (buffer.length >= 2) {
              const len = buffer.readUInt16BE();
              if (timeout && buffer.length >= 2 + len) {
                this._addTimingSuccess(Date.now() - start);
                clearTimeout(timeout);
                timeout = null;
                callback(DnsPkt.decode(buffer.subarray(2, 2 + len)));
              }
            }
            socket.end();
          });
          socket.write(msgout);
        });
      }
    }
    else {
      return (request, callback) => {
        while (this._pending[request.id]) {
          request.id = Math.floor(Math.random() * 65536);
        }
        const id = request.id;
        const timeout = setTimeout(() => {
          if (this._pending[id]) {
            this._addTimingFailure(Date.now() - start);
            delete this._pending[id];
            callback(null);
          }
        }, this._getTimeout());
        this._pending[id] = (message) => {
          this._addTimingSuccess(Date.now() - start);
          clearTimeout(timeout);
          delete this._pending[id];
          callback(DnsPkt.decode(message));
        };
        this._socket.send(DnsPkt.encode(request), this._port, this._address);
      }
    }
  },

  query: async function(request, response, rinfo) {
    // Dont send a query back to a server it came from.
    if (rinfo.address === this._address) {
      return false;
    }

    // Check we're not trying to looking up local addresses globally
    if (this._global && request.questions[0].type === 'A' || request.questions[0].type === 'AAAA') {
      const name = request.questions[0].name.split('.');
      const domain = name[name.length - 1].toLowerCase();
      if (domain === 'local' || domain === PrivateDNS._domainName) {
        return false;
      }
    }

    return new Promise((resolve, reject) => {
      try {
        this.getSocket(rinfo)(request, (pkt) => {
          if (pkt && pkt.rcode === 'NOERROR') {
            response.flags = pkt.flags;
            response.answers = pkt.answers;
            response.additionals = pkt.additionals;
            response.authorities = pkt.authorities;
            return resolve(true);
          }
          resolve(false);
        });
      }
      catch (e) {
        reject(e);
      }
    });
  },

  _addTimingSuccess: function(time) {
    this._samples.shift();
    this._samples.push(Math.min(time, this._maxTimeout));
  },

  _addTimingFailure: function(time) {
    const dev = this._stddev();
    this._addTimingSuccess(time + STDEV_FAIL * dev.deviation);
  },

  _getTimeout: function() {
    // The last proxy uses the maxTimeout because it's the final attempt at an answer and there's
    // no reason to terminate it early.
    if (DNS._proxies[DNS._proxies.length - 1].srv === this) {
      return this._maxTimeout;
    }
    else {
      const dev = this._stddev();
      return Math.max(1, Math.min(dev.mean + STDEV_QUERY * dev.deviation, this._maxTimeout));
    }
  },

  _stddev: function() {
    const mean = this._samples.reduce((total, value) => total + value, 0) / this._samples.length;
    const variance = this._samples.reduce((total, value) => total + Math.pow(value - mean, 2), 0) / (this._samples.length - 1);
    return {
      mean: mean,
      deviation: Math.sqrt(variance)
    };
  }

};

const LocalDNSSingleton = {

  _TIMEOUT: 1000 * 60 * 60 * 24,
  _qHighWater: 50,
  _qLowWater: 20,
  _forwardCache: {},
  _backwardCache: {},
  _pending: {},

  start: async function() {
    const home = await Network.getHomeNetwork();
    const homecidr = home.info.IPAM.Config[0].Subnet.split('/');
    this._bits = parseInt(homecidr[1]);

    this._dev = DNS_NETWORK;
    this._network = await Network.getDNSNetwork();

    const cidr = this._network.info.IPAM.Config[0].Subnet.split('/');
    const base = cidr[0].split('.');
    const basebits = parseInt(cidr[1]);

    // We need one more bit in the DNS network compared to the HOME network for simple mapping to be possible.
    if (basebits < this._bits) {
      // Simple mapping using mask
      this._mask = [ 0, 0, 0, 0 ];
      for (let i = this._bits; i < 32; i++) {
        this._mask[Math.floor(i / 8)] |= 128 >> (i % 8);
      }
      this._base = [ parseInt(base[0]), parseInt(base[1]), parseInt(base[2]), parseInt(base[3]) ];
      this._base[Math.floor(basebits / 8)] |= 128 >> (basebits % 8);
    }
    else {
      // Complex mapping using available
      this._base = [ parseInt(base[0]), parseInt(base[1]), parseInt(base[2]), 0 ];
      this._available = [];
    }

    const state = Object.assign({ map: [], dnsBase: '' }, (await Database.getConfig('localdns')));
    // Setup store entries as long as we're using the same dns network range.
    if (state.dnsBase === JSON.stringify(this._base)) {
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
    }

    if (this._available) {
      for (let i = 254; i >= 32; i--) {
        const dnsAddress = `${this._base[0]}.${this._base[1]}.${this._base[2]}.${i}`;
        if (!this._backwardCache[dnsAddress]) {
          this._available.push(dnsAddress);
        }
      }
    }
  },

  stop: async function() {
    const state = {
      _id: 'localdns',
      dnsBase: JSON.stringify(this._base),
      map: [],
    };
    for (let address in this._forwardCache) {
      state.map.push({ address: address, dnsAddress: this._forwardCache[address].dnsAddress });
    }
    await Database.saveConfig(state);
  },

  _allocAddress: function(address) {
    const now = Date.now();

    const saddress = address.split('.');
    let daddress;
    if (this._mask) {
      daddress = `${this._base[0] | (this._mask[0] & saddress[0])}.${this._base[1] | (this._mask[1] & saddress[1])}.${this._base[2] | (this._mask[2] & saddress[2])}.${this._base[3] | (this._mask[3] & saddress[3])}`;
    }
    else {
      daddress = `${this._base[0]}.${this._base[1]}.${this._base[2]}.${saddress[3]}`;
    }

    const matchEntry = this._backwardCache[daddress];
    if (matchEntry && now > matchEntry.lastUsed + this._TIMEOUT) {
      // Found an entry. We can use as it's expired.
      this._unbindInterface(daddress);
      this._releaseAddress(daddress);
      matchEntry.socket.close();
      matchEntry.socket = null;
      matchEntry.lastUse = now;
      matchEntry.address = address;
      matchEntry.dnsAddress = daddress;
      return matchEntry;
    }

    // For complex allocation, we need to allocate a address which we try to make a close match
    // but failing that will allocate something.
    if (this._available) {
      // Now see if we can just sneak the address from those available.
      const idx = this._available.indexOf(daddress);
      if (idx !== -1) {
        this._available.splice(idx, 1);
      }
      // But if not, we just get the next available
      else {
        daddress = this._available.shift();
      }
      if (this._available.length < this._qLowWater && !this._qPrune) {
        this._qPrune = setTimeout(() => this._pruneAddresses(), 0);
      }
    }

    const newEntry = {
      socket: null,
      lastUse: now,
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

  getSocket: async function(rinfo, tinfo) {
    const start = Date.now();
    if (rinfo.tcp) {
      return (request, callback) => {
        const message = DnsPkt.encode(request);
        const msgout = Buffer.alloc(message.length + 2);
        msgout.writeUInt16BE(message.length);
        message.copy(msgout, 2);
        let timeout = setTimeout(() => {
          if (timeout) {
            this._addTimingFailure(tinfo, Date.now() - start);
            timeout = null;
            callback(null);
          }
        }, this._getTimeout(tinfo));
        const socket = Net.createConnection(tinfo._port, tinfo._address, () => {
          socket.on('error', (e) => {
            console.error(e);
            if (timeout) {
              this._addTimingFailure(tinfo, Date.now() - start);
              clearTimeout(timeout);
              timeout = null;
              callback(null);
            }
            socket.destroy();
          });
          socket.on('data', (buffer) => {
            if (buffer.length >= 2) {
              const len = buffer.readUInt16BE();
              if (timeout && buffer.length >= 2 + len) {
                this._addTimingSuccess(tinfo, Date.now() - start);
                clearTimeout(timeout);
                timeout = null;
                callback(DnsPkt.decode(buffer.subarray(2, 2 + len)));
              }
            }
            socket.end();
          });
          socket.write(msgout);
        });
      }
    }
    else {
      const socket = await new Promise((resolve, reject) => {
        const entry = this._forwardCache[rinfo.address] || this._allocAddress(rinfo.address);
        if (entry.socket) {
          entry.lastUse = Date.now();
          resolve(entry.socket);
        }
        else {
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
              this._pending[id] && this._pending[id](message);
            });
            resolve(entry.socket);
          });
        }
      });
      return (request, callback) => {
        while (this._pending[request.id]) {
          request.id = Math.floor(Math.random() * 65536);
        }
        const id = request.id;
        const timeout = setTimeout(() => {
          if (this._pending[id]) {
            this._addTimingFailure(tinfo, Date.now() - start);
            delete this._pending[id];
            callback(null);
          }
        }, this._getTimeout(tinfo));
        this._pending[id] = (message) => {
          this._addTimingSuccess(tinfo, Date.now() - start);
          clearTimeout(timeout);
          delete this._pending[id];
          callback(DnsPkt.decode(message));
        };
        socket.send(DnsPkt.encode(request), tinfo._port, tinfo._address);
      }
    }
  },

  query: async function(request, response, rinfo, tinfo) {
    return new Promise(async (resolve, reject) => {
      try {
        (await this.getSocket(rinfo, tinfo))(request, (pkt) => {
          if (pkt && pkt.rcode === 'NOERROR') {
            response.flags = pkt.flags;
            response.answers = pkt.answers;
            response.additionals = pkt.additionals;
            response.authorities = pkt.authorities;
            return resolve(true);
          }
          resolve(false);
        });
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
  },

  _addTimingFailure: function(tinfo, time) {
    const dev = this._stddev(tinfo);
    this._addTimingSuccess(tinfo, time + STDEV_FAIL * dev.deviation);
  },

  _addTimingSuccess: function(tinfo, time) {
    tinfo._samples.shift();
    tinfo._samples.push(Math.min(time, tinfo._maxTimeout));
  },

  _getTimeout: function(tinfo) {
    const dev = this._stddev(tinfo);
    return Math.max(1, Math.min(dev.mean + STDEV_QUERY * dev.deviation, tinfo._maxTimeout));
  },

  _stddev: function(tinfo) {
    const mean = tinfo._samples.reduce((total, value) => total + value, 0) / tinfo._samples.length;
    const variance = tinfo._samples.reduce((total, value) => total + Math.pow(value - mean, 2), 0) / (tinfo._samples.length - 1);
    return {
      mean: mean,
      deviation: Math.sqrt(variance)
    };
  }
}

//
// LocalDNS proxies DNS servers on the DNS network.
//
const LocalDNS = function(addresses, port, timeout) {
  this._address = addresses[0];
  this._addresses = addresses
  this._port = port;
  this._maxTimeout = timeout;
  this._samples = Array(MAX_SAMPLES).fill(this._maxTimeout);
}

LocalDNS.prototype = {

  start: async function() {
  },

  stop: function() {
  },

  query: async function(request, response, rinfo) {
    // Dont send a query back to a server it came from.
    if (this._addresses.indexOf(rinfo.address) !== -1) {
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

//
// DNS
// The main DNS system. This fields request and then tries to answer them by walking though a prioritized list of DNS servers.
// By default these handle local names, mulitcast names, address maps, and caching. We can also add global dns servers (which are
// references to DNS services on the physical network) as well as local dns servers (which are dns servers on our internal DNS network).
//
const DNS = { // { app: app, srv: proxy, cache: cache }

  _proxies: [
    { app: { _name: 'private', _position: { tab: -9 } }, srv: PrivateDNS,   cache: false, local: true },
    { app: { _name: 'mdns',    _position: { tab: -8 } }, srv: MulticastDNS, cache: false, local: true },
    { app: { _name: 'map',     _position: { tab: -7 } }, srv: MapDNS,       cache: false, local: true },
    { app: { _name: 'cache',   _position: { tab: -6 } }, srv: CachingDNS,   cache: false, local: true }
  ],

  start: async function(config) {
    this.setDomainName(config.domainname);
    this.setHostname(config.hostname, config.ip);
    this.setDefaultResolver(config.resolvers[0], config.resolvers[1]);

    const onMessage = async (msgin, rinfo) => {
      //console.log(msgin, rinfo);
      const start = DEBUG_QUERY_TIMING && Date.now();
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
        if ((response.flags & DnsPkt.RECURSION_DESIRED) !== 0) {
          response.flags |= DnsPkt.RECURSION_AVAILABLE;
        }
        response.questions = request.questions;
        DEBUG_QUERY && console.log('request', rinfo, JSON.stringify(request, null, 2));
        await this.query(request, response, rinfo);
        // If we got no answers, and no error code set, we set notfound
        if (response.answers.length === 0 && (response.flags & 0x0F) === 0) {
          response.flags = (response.flags & 0xFFF0) | 3; // NOTFOUND
        }
      }
      catch (e) {
        console.error(e);
        response.flags = (response.flags & 0xFFF0) | 2; // SERVFAIL
      }
      DEBUG_QUERY && console.log('response', rinfo.tcp ? 'tcp' : 'udp', rinfo, JSON.stringify(DnsPkt.decode(DnsPkt.encode(response)), null, 2));
      DEBUG_QUERY_TIMING && console.log(`Query time ${Date.now() - start}ms: ${response.questions[0].name} ${response.questions[0].type}`);
      return DnsPkt.encode(response);
    }

    await new Promise(resolve => {
      const run = (callback) => {
        this._udp = UDP.createSocket({
          type: 'udp4',
          reuseAddr: true
        });
        this._udp.on('message', async (msgin, rinfo) => {
          const msgout = await onMessage(msgin, { tcp: false, address: rinfo.address, port: rinfo.address });
          this._udp.send(msgout, rinfo.port, rinfo.address, err => {
            if (err) {
              console.error(err);
            }
          });
        });
        this._udp.on('error', (e) => {
          console.log('DNS socket error - reopening');
          console.error(e);
          try {
            this._udp.close();
            this._udp = null;
          }
          catch (_) {
          }
          // Wait a moment before reopening
          setTimeout(() => run(() => {}), 1000);
        });
        this._udp.bind(config.port, callback);
      }
      run(resolve);
    });

    // Super primitive DNS over TCP handler
    await new Promise(resolve => {
      this._tcp = Net.createServer((socket) => {
        socket.on('error', (e) => {
          console.error(e);
          socket.destroy();
        });
        socket.on('data', async (buffer) => {
          try {
            if (buffer.length >= 2) {
              const len = buffer.readUInt16BE();
              if (buffer.length >= 2 + len) {
                const msgin = buffer.subarray(2, 2 + len);
                const msgout = await onMessage(msgin, { tcp: true, address: socket.remoteAddress, port: socket.remotePort });
                const reply = Buffer.alloc(msgout.length + 2);
                reply.writeUInt16BE(msgout.length, 0);
                msgout.copy(reply, 2);
                socket.write(reply);
              }
            }
          }
          catch (e) {
            console.error(e);
          }
          socket.end();
        });
      });
      this._tcp.on('error', (e) => {
        // If we fail to open the dns/tcp socket, report and move on.
        console.error(e);
        resolve();
      });
      this._tcp.listen(config.port, resolve);
    });

    await LocalDNSSingleton.start();

    // DNS order determined by app order in the tabs. If that changes we re-order DNS.
    // We flush the cache if the reordering is material to the DNS.
    Root.on('apps.tabs.reorder', () => {
      const order = this._proxies.reduce((t, a) => `${t},${a.app._name}`, '');
      this._proxies.sort((a, b) => a.app._position.tab - b.app._position.tab);
      const norder = this._proxies.reduce((t, a) => `${t},${a.app._name}`, '');
      if (order !== norder) {
        CachingDNS.flush();
      }
    });
  },

  stop: async function() {
    this._udp.close();
    this._tcp.close();
    await LocalDNSSingleton.stop();
  },

  setDefaultResolver: function(resolver1, resolver2) {
    this.removeDNSServer({ app: GLOBAL1 });
    this.removeDNSServer({ app: GLOBAL2 });
    if (resolver1) {
      this._addDNSProxy(GLOBAL1, new GlobalDNS(resolver1, 53, 5000), true, false);
    }
    if (resolver2) {
      this._addDNSProxy(GLOBAL2, new GlobalDNS(resolver2, 53, 5000), true, false);
    }
  },

  addDNSServer: function(app, args) {
    const proxy = args.dnsNetwork ?
      new LocalDNS([ app._secondaryIP, app._homeIP ], args.port || 53, args.timeout || 5000) :
      new GlobalDNS(app._homeIP, args.port || 53, args.timeout || 5000);
    this._addDNSProxy(app, proxy, true, false);
    return { app: app };
  },

  _addDNSProxy: function(app, proxy, cache, local) {
    proxy.start().then(() => {
      this._proxies.push({ app: app, srv: proxy, cache: cache, local: local });
      this._proxies.sort((a, b) => a.app._position.tab - b.app._position.tab);
    });
    CachingDNS.flush();
  },

  removeDNSServer: function(dns) {
    for (let i = 0; i < this._proxies.length; i++) {
      if (this._proxies[i].app === dns.app) {
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

  lookupLocalnameIP: function(localname) {
    return PrivateDNS.lookupLocalnameIP(localname);
  },

  squery: async function(request, response, rinfo) {
    const question = request.questions[0];
    if (!question) {
      throw new Error('Missing question');
    }
    for (let i = 0; i < this._proxies.length; i++) {
      const proxy = this._proxies[i];
      DEBUG_QUERY && console.log(`Trying ${proxy.app._name}`);
      if (await proxy.srv.query(request, response, rinfo)) {
        DEBUG_QUERY && console.log('Found');
        if (proxy.cache) {
          CachingDNS.add(response);
        }
        return true;
      }
    }
    DEBUG_QUERY && console.log('Not found');
    if (response.authorities.length) {
      CachingDNS.add(response);
    }
    response.flags = (response.flags & 0xFFF0) | 3; // NOTFOUND
    return false;
  },

  pquery: async function(request, response, rinfo) {
    const question = request.questions[0];
    if (!question) {
      throw new Error('Missing question');
    }
    const done = [];
    let i = 0;
    for (; i < this._proxies.length; i++) {
      const proxy = this._proxies[i];
      if (!proxy.local) {
        break;
      }
      DEBUG_QUERY && console.log(`Trying local ${proxy.app._name}`);
      if (await proxy.srv.query(request, response, rinfo)) {
        DEBUG_QUERY && console.log('Found');
        if (proxy.cache) {
          CachingDNS.add(response);
        }
        return true;
      }
      done[i] = 'fail';
    }
    if (i >= this._proxies.length) {
      return false;
    }
    const vresponse = await new Promise(resolve => {
      let replied = false;
      for(; i < this._proxies.length; i++) {
        const proxy = this._proxies[i];
        DEBUG_QUERY && console.log(`Trying ${proxy.app._name}`);
        const presponse = {
          id: response.id,
          type: response.type,
          flags: response.flags,
          questions: response.questions,
          answers: [],
          authorities: [],
          additionals: []
        };
        const idx = i;
        const start = DEBUG_QUERY_TIMING && Date.now();
        proxy.srv.query(Object.assign({}, request), presponse, rinfo).then(success => {
          DEBUG_QUERY && console.log(`Reply ${this._proxies[idx].app._name}`, success);
          DEBUG_QUERY_TIMING && console.log(`Query time ${Date.now() - start}ms ${this._proxies[idx].app._name}: ${question.name} ${question.type}`);
          if (!replied) {
            done[idx] = success ? presponse : 'fail';
            for (let k = 0; k < this._proxies.length; k++) {
              if (!done[k]) {
                // Query pending before we find an answer - need to wait for it to complete
                return;
              }
              else if (done[k] !== 'fail') {
                // Found an answer after earlier queries failed, go with this.
                replied = true;
                DEBUG_QUERY && console.log(`Success ${this._proxies[idx].app._name}`);
                if (this._proxies[k].cache) {
                  CachingDNS.add(done[k]);
                }
                return resolve(done[k]);
              }
            }
            // Everything failed
            replied = true;
            DEBUG_QUERY && console.log('Not found');
            return resolve(null);
          }
        });
      }
    });
    if (!vresponse) {
      return false;
    }
    Object.assign(response, vresponse);
    return true;
  }

};

DNS.query = PARALLEL_QUERY ? DNS.pquery : DNS.squery;

module.exports = DNS;
