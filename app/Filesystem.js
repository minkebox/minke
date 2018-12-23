const FS = require('fs');
const ChildProcess = require('child_process');

const FS_PREFIX = process.env.DEBUG ? '/tmp/minke' : '/minke';
let FS_HOSTPREFIX = FS_PREFIX;

const shares = {};

function Filesystem(app) {
  this._name = app._name;
  this._root = `${FS_PREFIX}/fs/app/${this._name}`;
  this._hostroot = `${FS_HOSTPREFIX}/fs/app/${this._name}`;
  FS.mkdirSync(this._root, { recursive: true });
  FS.mkdirSync(`${this._root}/private`, { recursive: true });
  FS.mkdirSync(`${this._root}/shared`, { recursive: true });
}

Filesystem.prototype = {

  _map: {},

  mapPrivateVolume: function(path) {
    this._map[path] = { type: 'private', path: path, dest: `${this._hostroot}/private/${path}` };
    FS.mkdirSync(this._map[path].dest, { recursive: true });
    return `${this._map[path].dest}:${path}`;
  },

  mapShareableVolume: function(path) {
    this._map[path] = { type: 'shared', path: path, dest: `${this._hostroot}/shared/${path}` };
    FS.mkdirSync(this._map[path].dest, { recursive: true });
    return `${this._map[path].dest}:${path}`;
  },

  isShared: function(sharename) {
    return !!shares[sharename];
  },

  makeShared: function(path, sharename) {
    const map = this._map[path];
    if (map.type === 'shared' && !shared[sharename]) {
      map.share = {
        name: sharename,
        dest: `${FS_PREFIX}/fs/shared/${sharename}`,
      };
      shares[sharename] = map;
      FS.mkdirSync(map.share.dest, { recursive: true });
      if (!this._isMountpoint(map.share.dest)) {
        ChildProcess.spawnSync('/bin/mount', [ '--bind', map.dest, map.share.dest ]);
      }
    }
  },

  makeUnshared: function(sharename) {
    const map = shares[sharename];
    if (map && map.share && this._isMountpoint(map.share.dest)) {
      ChildProcess.spawnSync('/bin/umount', [ map.share.dest ]);
      delete map.share;
      delete shared[sharename];
    }
  },

  _isMountpoint: function(path) {
    const r = ChildProcess.spawnSync('/bin/mountpoint', [ '-q', path ]);
    return r.status === 0;
  }

}

const _Filesystem = {

  createAppFS: function(app) {
    return new Filesystem(app);
  },

  setHostPrefix: function(prefix) {
    FS_HOSTPREFIX = prefix;
  }

};

module.exports = _Filesystem;
