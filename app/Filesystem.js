const FS = require('fs');
const ChildProcess = require('child_process');

const FS_SHARED_ROOT = process.env.DEBUG ? '/tmp/minke/fs/shared' : '/minke/fs/shared';
const FS_ROOT = process.env.DEBUG ? '/tmp/minke/fs/app' : '/minke/fs/app';

const shares = {};

function Filesystem(app) {
  this._name = app._name;
  this._root = `${FS_ROOT}/${this._name}`;
  FS.mkdirSync(this._root, { recursive: true });
  FS.mkdirSync(`${this._root}/private`, { recursive: true });
  FS.mkdirSync(`${this._root}/shared`, { recursive: true });
}

Filesystem.prototype = {

  _map: {},

  mapPrivateVolume: function(path) {
    this._map[path] = { type: 'private', path: path, dest: `${this._root}/private/${path}` };
    FS.mkdirSync(this._map[path].dest, { recursive: true });
    return `${this._map[path].dest}:${path}`;
  },

  mapSharedVolume: function(path) {
    this._map[path] = { type: 'shared', path: path, dest: `${this._root}/shared/${path}` };
    FS.mkdirSync(this._map[path].dest, { recursive: true });
    return `${this._map[path].dest}:${path}`;
  },

  isShared: function(sharename) {
    return !!shares[sharename];
  },

  makeSharable: function(path, sharename) {
    const map = this._map[path];
    const shared = `${FS_SHARED_ROOT}/${sharename}`
    if (map.type === 'shared' && !shared[sharename]) {
      map.sharename = sharename;
      map.shared = shared;
      shares[sharename] = map;
      FS.mkdirSync(shared, { recursive: true });
      if (!this._isMountpoint(map.shared)) {
        ChildProcess.spawnSync('/bin/mount', [ '--bind', map.dest, map.shared ]);
      }
    }
  },

  makeUnsharable: function(sharename) {
    const map = shares[sharename];
    if (map && this._isMountpoint(map.shared)) {
      ChildProcess.spawnSync('/bin/umount', [ map.shared ]);
      delete map.shared;
      delete map.sharename;
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
  }

};

module.exports = _Filesystem;
