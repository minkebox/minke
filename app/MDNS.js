const ChildProcess = require('child_process');

const DEBUG = process.env.DEBUG;

const AVAHI = '/usr/sbin/avahi-daemon'

let avahi = null;
let stopping = false;

const MDNS = {

  start: function() {
    if (!DEBUG) {
      function avahiRun() {
        if (!stopping) {
          avahi = ChildProcess.spawn(AVAHI, [ '--no-drop-root' ]);
          avahi.on('exit', avahiRun);
        }
      }
      if (!avahi) {
        avahiRun();
      }
    }
  },

  stop: function() {
    stopping = true;
    if (avahi) {
      avahi.kill();
      avahi = null;
    }
  },

  update: function(config) {
    if (avahi) {
      avahi.kill();
      avahi = null;
    }
  }

};

module.exports = MDNS;
