const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');

const FS_PREFIX = process.env.DEBUG ? '/tmp/minke' : '/minke';
let FS_HOSTPREFIX = FS_PREFIX;


function Filesystem(app) {
  this._name = app._name;
  this._mappings = app._binds;
  this._shares = [];
  // Handle Samba specially
  if (this._image === 'timwilkinson/samba') {
    this._root = `${FS_PREFIX}/fs`;
    this._hostroot = `${FS_HOSTPREFIX}/fs`;
  }
  else {
    this._root = `${FS_PREFIX}/fs/app/${this._name}`;
    this._hostroot = `${FS_HOSTPREFIX}/fs/app/${this._name}`;
  }
}

Filesystem.prototype = {

  mapPrivateVolume: function(path) {
    const map = {
      description: '',
      shareable: false,
      shared: false,
      host: Path.normalize(path),
      target: path
    }
    this._mappings.push(map);
    return map;
  },

  mapShareableVolume: function(path) {
    const map = {
      description: '',
      shareable: true,
      shared: false,
      host: Path.normalize(path),
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

  mapFilenameToLocal: function(filename) {
    for (let i = 0; i < this._mappings.length; i++) {
      const bind = this._mappings[i];
      if (filename.startsWith(bind.target)) {
        return Path.normalize(`${this._root}/${bind.host}/${filename.substring(bind.target.length)}`);
      }
    }
    return null;
  },

  shareVolume: function(map) {
    const sharepoint = `${FS_PREFIX}/fs/shareable/${map.sharepoint || map.target.split('/').slice(-1)[0]}`;
    if (map.shareable && map.shared) {
      if (!FS.existsSync(sharepoint)) {
        FS.mkdirSync(sharepoint);
      }
      ChildProcess.spawnSync('/bin/mount', [ '--bind', '-o', 'rshared', `${this._hostroot}/${map.host}`, sharepoint ]);
      this._shares.push(sharepoint);
    }
    else {
      if (FS.existsSync(sharepoint)) {
        FS.rmdirSync(sharepoint);
      }
    }
  },

  unshareVolumes: function() {
    this._shares.forEach((sharepoint) => {
      ChildProcess.spawnSync('/bin/umount', [ sharepoint ]);
      if (FS.existsSync(sharepoint)) {
        FS.rmdirSync(sharepoint);
      }
    });
    this._shares = [];
  }

}

const _Filesystem = {

  create: function(app) {
    return new Filesystem(app);
  },

  setHostPrefix: function(prefix) {
    FS_HOSTPREFIX = prefix;
    FS.mkdirSync(`${FS_PREFIX}/fs/shareable`, { recursive: true });
  }

};

module.exports = _Filesystem;
