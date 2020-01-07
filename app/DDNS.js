const HTTPS = require('https');
const UPNP = require('./UPNP');

const ENABLE_FALLBACK = false;
const GETIP = 'https://api.ipify.org';
const DDNS_URL = 'https://minkebox.net/update';
const TICK = 30 * 60 * 1000; // 30 minutes
const RETRY = 60 * 1000; // 1 minute
const DELAY = 10 * 1000; // 10 seconds
const FORCE_TICKS = 48; // 1 day

const DDNS = {

  _gids: {},
  _lastip: null,
  _pending: null,

  start: function() {
    let ticks = 0;
    this._tick = setInterval(async () => {
      this._update(ticks === 0);
      ticks--;
      if (ticks < 0) {
        ticks = FORCE_TICKS;
      }
    }, TICK);
  },

  register: function(app) {
    //console.log('register', app._globalId);
    const gid = app._globalId;
    if (!(gid in this._gids)) {
      this._gids[gid] = app;
      this._update(true);
    }
  },

  unregister: function(app) {
    //console.log('unregister', app._globalId);
    delete this._gids[app._globalId];
  },

  _update: function(force) {
    if (Object.keys(this._gids).length) { // Dont store keys - may change after we've got the IP address
      if (force) {
        this._lastip = null;
      }
      clearTimeout(this._pending);
      this._pending = setTimeout(() => {
        this._getExternalIP().then((ip) => {
          if (!ip) {
            setTimeout(() => {
              this._update(true);
            }, RETRY);
          }
          else if (ip !== this._lastip) {
            this._lastip = ip;
            const ip4only = [];
            Object.keys(this._gids).forEach(key => {
              const app = this._gids[key];
              const ip6 = app.getSLAACAddress();
              if (!ip6) {
                ip4only.push(key);
              }
              else {
                console.log(`${DDNS_URL}?host=${key}&ip=${ip}&ip6=${ip6.canonicalForm()}`);
                HTTPS.get(`${DDNS_URL}?host=${key}&ip=${ip}&ip6=${ip6.canonicalForm()}`, () => {});
              }
            });
            if (ip4only.length) {
              console.log(`${DDNS_URL}?host=${ip4only.join(',')}&ip=${ip}`);
              HTTPS.get(`${DDNS_URL}?host=${ip4only.join(',')}&ip=${ip}`, () => {});
            }
          }
        });
      }, DELAY);
    }
  },

  _getExternalIP: async function() {
    return new Promise((resolve) => {
      //console.log('_getExternalIP');
      UPNP.getExternalIP().then((ip) => {
        //console.log('_gotExternaIP', ip);
        if (ip) {
          resolve(ip);
        }
        else if (ENABLE_FALLBACK) {
          // Fallback
          HTTPS.get(GETIP, (res) => {
            res.on('data', (data) => {
              resolve(data.toString('utf8'));
            });
          });
        }
        else {
          resolve(null);
        }
      });
    });
  }

}

module.exports = DDNS;
