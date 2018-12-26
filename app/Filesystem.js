const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');

const FS_PREFIX = process.env.DEBUG ? '/tmp/minke' : '/minke';
let FS_HOSTPREFIX = FS_PREFIX;


function Filesystem(app) {
  this._name = app._name;
  this._root = `${FS_PREFIX}/fs/app/${this._name}`;
  this._hostroot = `${FS_HOSTPREFIX}/fs/app/${this._name}`;
  FS.mkdirSync(this._root, { recursive: true });
  FS.mkdirSync(`${this._root}/private`, { recursive: true });
  FS.mkdirSync(`${this._root}/shareable`, { recursive: true });
}

Filesystem.prototype = {

  mapPrivateVolume: function(path) {
    FS.mkdirSync(`${this._root}/private/${path}`, { recursive: true });
    return {
      name: `${this._name}:${path}`,
      shareable: false,
      host: Path.normalize(`${this._hostroot}/private/${path}`),
      target: path
    }
  },

  mapShareableVolume: function(path) {
    FS.mkdirSync(`${this._root}/shareable/${path}`, { recursive: true });
    return {
      name: `${this._name}:${path}`,
      shareable: true,
      host: Path.normalize(`${this._hostroot}/shareable/${path}`),
      target: path
    }
  }

}

const _Filesystem = {

  createAppFS: function(app) {
    return new Filesystem(app);
  },

  setHostPrefix: function(prefix) {
    FS_HOSTPREFIX = prefix;
    FS.mkdirSync(`${FS_PREFIX}/fs/shareable`, { recursive: true });
  }

};

module.exports = _Filesystem;
