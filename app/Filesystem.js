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
  this._shares = app._shares;
  this._root = `${FS_PREFIX}/fs/app/${this._app._id}`;
  this._hostroot = `${FS_HOSTPREFIX}/app/${this._app._id}`;
}

Filesystem.prototype = {

  getAllMounts: function() {
    return this._mappings.map(map => this._makeMount(map)).concat(
      this._files.map(file => this.makeFile(file)),
      this._shares.map(share => this.makeShare(share))
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

  makeShare: function(share) {
    return {
      Type: 'bind',
      Source: Path.normalize(`${FS_HOSTPREFIX}/app/${share.appid}/${share.host}`),
      Target: share.target,
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

  uninstall: function() {
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
