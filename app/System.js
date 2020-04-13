const OS = require('os');
const FS = require('fs');

const MEMINFO = '/proc/meminfo';
const TICK = 10 * 1000; // 10 seconds
const EVENT_NAME = 'system.stats';

const System = {

  _lastIdle: 0,
  _lastActive: 0,
  _cpuLoad: 0,
  _memoryUsed: 0,

  _updateMemory: function() {
    const lines = FS.readFileSync(MEMINFO, { encoding: 'utf8' }).split('\n');
    let count = 0;
    let memtotal = 1;
    let memavailable = 1;
    for (let i = 0; i < lines.length && count < 2; i++) {
      const line = lines[i];
      if (line.indexOf('MemTotal:') === 0) {
        memtotal = parseInt(line.substring(9));
        count++;
      }
      else if (line.indexOf('MemAvailable:') === 0) {
        memavailable = parseInt(line.substring(13));
        count++;
      }
    }
    if (count === 2) {
      this._memoryUsed = Math.floor(100 - memavailable / memtotal * 100);
    }
  },

  _updateCPU: function() {
    const cpus = OS.cpus();
    const idle = cpus.reduce((total, cpu) => total + cpu.times.idle, 0);
    const active = cpus.reduce((total, cpu) => total + cpu.times.user + cpu.times.sys + cpu.times.nice + cpu.times.irq, 0);
    const iDiff = idle - this._lastIdle;
    const aDiff = active - this._lastActive;
    if (aDiff + iDiff > 0) {
      this._cpuLoad = Math.floor(100 * aDiff / (aDiff + iDiff));
      this._lastIdle = idle;
      this._lastActive = active;
    }
  },

  start: function() {
    let timer = null;
    Root.on(`${EVENT_NAME}.start`, () => {
      const update = () => {
        this._updateMemory();
        this._updateCPU();
        Root.emit(EVENT_NAME, { cpuLoad: this._cpuLoad, memoryUsed: this._memoryUsed });
      };
      if (timer) {
        clearInterval(timer);
      }
      timer = setInterval(update, TICK);
      update();
    });
    Root.on(`${EVENT_NAME}.stop`, () => {
      clearInterval(timer);
      timer = null;
    });
  }

};

module.exports = System;
