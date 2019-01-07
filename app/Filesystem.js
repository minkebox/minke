const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');

const FS_PREFIX = process.env.DEBUG ? '/tmp/minke' : '/minke';
let FS_HOSTPREFIX = FS_PREFIX;


function Filesystem(app) {
  this._name = app._name;
  this._mappings = app._binds;
  this._root = `${FS_PREFIX}/fs/app/${this._name}`;
  this._hostroot = `${FS_HOSTPREFIX}/fs/app/${this._name}`;
  FS.mkdirSync(`${this._root}/private`, { recursive: true });
  FS.mkdirSync(`${this._root}/shareable`, { recursive: true });
}

Filesystem.prototype = {

  mapPrivateVolume: function(path) {
    const map = {
      name: `${this._name}:${path}`,
      shareable: false,
      host: Path.normalize(`/private/${path}`),
      target: path
    }
    this._mappings.push(map);
    return map;
  },

  mapShareableVolume: function(path) {
    const map = {
      name: `${this._name}:${path}`,
      shareable: true,
      host: Path.normalize(`/shareable/${path}`),
      target: path
    };
    this._mappings.push(map);
    return map;
  },

  getAllMounts: function() {
    return this._mappings.map(map => this._makeMount(map));
  },

  _makeMount: function(bind) {
    const src = Path.normalize(`${this._hostroot}/${bind.host}`);
    FS.mkdirSync(`${this._root}/${bind.host}`, { recursive: true });
    return {
      Type: 'bind',
      Source: src,
      Target: bind.target,
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  getLocal: function(bind) {
    return `${this._root}/${bind.host}`;
  },

  mapFilenameToLocal: function(filename) {
    for (let i = 0; i < this._mappings.length; i++) {
      const bind = this._mappings[i];
      if (filename.indexOf(bind.target) === 0) {
        return Path.normalize(`${getLocal(bind)}/${filename.substring(bind.target.length)}`);
      }
    }
    return null;
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
