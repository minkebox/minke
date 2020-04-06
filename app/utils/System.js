const OS = require('os');
const FS = require('fs');

const MEMINFO = '/proc/meminfo';
const CPU_TICK = 10 * 1000; // 10 seconds

const System = {

  _lastIdle: 0,
  _lastActive: 0,
  _cpuLoad: 0,

  getUsedMemory: function() {
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
    if (count != 2) {
      return 0;
    }
    return Math.floor(100 - memavailable / memtotal * 100);
  },

  getCpuLoad: function() {
    return this._cpuLoad;
  }

};

setInterval(() => {
  const cpus = OS.cpus();
  const idle = cpus.reduce((total, cpu) => total + cpu.times.idle, 0);
  const active = cpus.reduce((total, cpu) => total + cpu.times.user + cpu.times.sys + cpu.times.nice + cpu.times.irq, 0);
  const iDiff = idle - System._lastIdle;
  const aDiff = active - System._lastActive;
  if (aDiff + iDiff > 0) {
    System._cpuLoad = Math.floor(100 * aDiff / (aDiff + iDiff));
    System._lastIdle = idle;
    System._lastActive = active;
  }
}, CPU_TICK);

System.getCpuLoad(); // Prime the system

module.exports = System;
