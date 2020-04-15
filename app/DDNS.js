const HTTPS = require('https');
const Config = require('./Config');
const UPNP = require('./UPNP');

const FALLBACK_GETIP = 'http://api.ipify.org';
const DDNS_URL = `${Config.DDNS_UPDATE}`;
const TICKS = 30 * 60 * 1000; // 30 minutes
const FORCE_TICKS = 24 * 60 * 60 * 1000; // 1 day
const RETRY = 60 * 1000; // 1 minute
const DELAY = 10 * 1000; // 10 seconds

const DDNS = {

  _gids: {},
  _pending: null,
  _key: '',
  _tick: null,

  start: function(key) {
    this._key = key;
    let ticks = 0;
    if (this._tick) {
      clearInterval(this._tick);
    }
    this._tick = setInterval(() => {
      this._update(ticks <= 0);
      ticks--;
      if (ticks < 0) {
        ticks = Math.floor(FORCE_TICKS / TICKS);
      }
    }, TICKS);

    this._humanVerified = (evt) => {
      if (evt.human === 'yes') {
        this._update(true);
      }
    };
    Root.on('human.verified', this._humanVerified);
  },

  stop: function() {
    Root.off('human.verified', this._humanVerified);
  },

  register: function(app) {
    //console.log('register', app._globalId);
    this._gids[app._globalId] = {
      app: app,
      lastIP: null,
      lastIP6: null
    };
    this._update(true);
  },

  unregister: function(app) {
    //console.log('unregister', app._globalId);
    delete this._gids[app._globalId];
  },

  _update: function(force) {
    if (Object.keys(this._gids).length) { // Dont store keys - may change after we've got the IP address
      if (force) {
        Object.values(this._gids).forEach(entry => {
          entry.lastIP = null;
          entry.lastIP6 = null;
        });
      }
      clearTimeout(this._pending);
      this._pending = setTimeout(() => {
        this._getExternalIP().then(eip => {
          if (!eip) {
            setTimeout(() => this._update(true), RETRY);
          }
          else {
            Object.keys(this._gids).forEach(gid => {
              const entry = this._gids[gid];
              const ip = entry.app._remoteIP || eip;
              const ip6 = entry.app.getNATIP6() ? entry.app.getSLAACAddress() : null;
              if (ip != entry.lastIP || ip6 != entry.lastIP6) {
                if (ip) {
                  if (!ip6) {
                    //console.log(`${DDNS_URL}?key=${this._key}&host=${gid}&ip=${ip}`);
                    HTTPS.get(`${DDNS_URL}?key=${this._key}&host=${gid}&ip=${ip}`, () => {});
                  }
                  else {
                    //console.log(`${DDNS_URL}?key=${this._key}&host=${gid}&ip=${ip}&ip6=${ip6}`);
                    HTTPS.get(`${DDNS_URL}?key=${this._key}&host=${gid}&ip=${ip}&ip6=${ip6}`, () => {});
                  }
                }
                entry.lastIP = ip;
                entry.lastIP6 = ip6;
              }
            });
          }
        });
      }, DELAY);
    }
  },

  _getExternalIP: async function() {
    return new Promise(resolve => {
      //console.log('_getExternalIP');
      UPNP.getExternalIP().then((ip) => {
        //console.log('_gotExternaIP', ip);
        if (ip) {
          resolve(ip);
        }
        else if (FALLBACK_GETIP) {
          // Fallback
          HTTPS.get(FALLBACK_GETIP, (res) => {
            res.on('data', (data) => {
              console.log('_gotExternaIP fallback', data.toString('utf8'));
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
