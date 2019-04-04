const HTTPS = require('https');
const UPNP = require('./UPNP');

const GETIP = 'https://api.ipify.org';
const DDNS_URL = 'https://minkebox.net/update';
const TICK = 30 * 60 * 1000; // 30 minutes
const RETRY = 60 * 1000; // 1 minute
const DELAY = 10 * 1000; // 10 seconds

const DDNS = {

  _gids: [],
  _lastip: null,
  _pending: null,

  start: function() {
    this._tick = setInterval(async () => {
      this._update();
    }, TICK);
  },

  register: function(app) {
    //console.log('register', app._globalId);
    const gid = app._globalId;
    if (this._gids.indexOf(gid) === -1) {
      this._gids.push(gid);
      this._update(true);
    }
  },

  unregister: function(app) {
    //console.log('unregister', app._globalId);
    const gid = app._globalId;
    const idx = this._gids.indexOf(gid);
    if (idx !== -1) {
      this._gids.splice(idx, 1);
    }
  },

  _update: function(force) {
    if (this._gids.length) {
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
            //console.log(`${DDNS_URL}?host=${this._gids.join(',')}&ip=${ip}`);
            HTTPS.get(`${DDNS_URL}?host=${this._gids.join(',')}&ip=${ip}`, () => {});
          }
        });
      }, DELAY);
    }
  },

  _getExternalIP: async function() {
    return new Promise((resolve) => {
      UPNP.getExternalIP().then((ip) => {
        if (ip) {
          resolve(ip);
        }
        else {
          // Fallback
          HTTPS.get(GETIP, (res) => {
            res.on('data', (data) => {
              resolve(data.toString('utf8'));
            });
          });
        }
      });
    });
  }

}

module.exports = DDNS;
