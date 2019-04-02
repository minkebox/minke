const HTTPS = require('https');
const UPNP = require('./UPNP');

const DDNS_URL = 'https://minkebox.net/update';
const TICK = 30 * 60 * 1000; // 30 minutes

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
        UPNP.getExternalIP().then((ip) => {
          if (ip && (ip !== this._lastip)) {
            this._lastip = ip;
            //console.log(`${DDNS_URL}?host=${this._gids.join(',')}&ip=${ip}`);
            HTTPS.get(`${DDNS_URL}?host=${this._gids.join(',')}&ip=${ip}`, () => {});
          }
        });
      }, 1000);
    }
  }

}

module.exports = DDNS;
