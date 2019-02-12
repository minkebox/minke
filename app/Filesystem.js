const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');
const Images = require('./Images');

process.umask(0);

const FS_PREFIX = process.env.DEBUG ? '/home/minke' : '/minke';
let FS_HOSTPREFIX = `${FS_PREFIX}/fs`;


function Filesystem(app) {
  this._app = app;
  this._mappings = app._binds;
  this._files = app._files;
  this._shares = [];
  // Handle internal Samba server specially
  if (app._image === Images.MINKE_SAMBA) {
    this._root = `${FS_PREFIX}/fs`;
    this._hostroot = `${FS_HOSTPREFIX}`;
  }
  else {
    this._root = `${FS_PREFIX}/fs/app/${this._app._id}`;
    this._hostroot = `${FS_HOSTPREFIX}/app/${this._app._id}`;
  }
}

Filesystem.prototype = {

  getAllMounts: function() {
    return this._mappings.map(map => this._makeMount(map)).concat(
      this._files.map(file => this.makeFile(file))
    );
  },

  _makeMount: function(bind) {
    FS.mkdirSync(`${this._root}/${bind.host}`, { recursive: true });
    return {
      Type: 'bind',
      Source: Path.normalize(`${this._hostroot}/${bind.host}`),
      Target: bind.target,
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  makeFile: function(file) {
    const src = Path.normalize(`${this._root}/${file.host}`);
    FS.mkdirSync(Path.dirname(src), { recursive: true });
    FS.writeFileSync(src, 'altData' in file ? file.altData : file.data);
    return {
      Type: 'bind',
      Source: Path.normalize(`${this._hostroot}/${file.host}`),
      Target: file.target,
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  readFile: function(file) {
    const src = Path.normalize(`${this._root}/${file.host}`);
    file.data = FS.readFileSync(src, { encoding: 'utf8' });
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
    const sharepoint = `${FS_PREFIX}/fs/dir/shareable/${map.sharepoint || (this._app._name + '/' + map.target.split('/').slice(-1)[0])}`;
    const shareparent = map.sharepoint ? null :`${FS_PREFIX}/fs/dir/shareable/${this._app._name}`;
    if (map.shareable && map.shared) {
      if (!FS.existsSync(sharepoint)) {
        FS.mkdirSync(sharepoint, { recursive: true });
      }
      ChildProcess.spawnSync('/bin/mount', [ '--bind', '-o', 'rshared', `${this._root}/${map.host}`, sharepoint ]);
      this._shares.push({ shareparent: shareparent, sharepoint: sharepoint });
    }
    else {
      try {
        if (FS.existsSync(sharepoint)) {
          FS.rmdirSync(sharepoint);
          if (shareparent) {
            FS.rmdirSync(shareparent);
          }
        }
      }
      catch (_) {
      }
    }
  },

  unshareVolumes: function() {
    this._shares.forEach((share) => {
      ChildProcess.spawnSync('/bin/umount', [ '-l', share.sharepoint ]);
      try {
        if (FS.existsSync(share.sharepoint)) {
          FS.rmdirSync(share.sharepoint);
          if (share.shareparent) {
            FS.rmdirSync(share.shareparent);
          }
        }
      }
      catch (_) {
      }
    });
    this._shares = [];
  },

  uninstall: function() {
    if (this._app._image === Images.MINKE_SAMBA) {
      return;
    }
    const rmAll = (path) => {
      if (FS.existsSync(path)) {
        FS.readdirSync(path).forEach((file) => {
          const curPath = path + '/' + file;
          if (FS.lstatSync(curPath).isDirectory()) {
            rmAll(curPath);
          }
          else {
            //console.log(`unlink ${curPath}`);
            FS.unlinkSync(curPath);
          }
        });
        //console.log(`rmdir ${path}`);
        FS.rmdirSync(path);
      }
    };
    this.unshareVolumes();
    rmAll(this._root);
  }

}

const _Filesystem = {

  create: function(app) {
    return new Filesystem(app);
  },

  setHostPrefix: function(prefix) {
    FS_HOSTPREFIX = prefix;
    FS.mkdirSync(`${FS_PREFIX}/fs/dir/shareable`, { recursive: true });
  }

};

module.exports = _Filesystem;
