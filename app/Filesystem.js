const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');
const Images = require('./Images');

process.umask(0);

const FS_PREFIX = process.env.DEBUG ? '/home/minke' : '/minke';
let FS_HOSTPREFIX = `${FS_PREFIX}/fs`;


function Filesystem(app) {
  this._app = app;
  this._binds = app._binds;
  this._files = app._files;
  this._shares = app._shares;
  this._customshares = app._customshares;
  this._root = `${FS_PREFIX}/fs/app/${this._app._id}`;
  this._hostroot = `${FS_HOSTPREFIX}/app/${this._app._id}`;
}

Filesystem.prototype = {

  getAllMounts: function() {

    // Remove any broken shares (in case an app was uninstalled)
    for (let i = 0; i < this._shares.length; ) {
      const share = this._shares[i];
      if (FS.existsSync(`${FS_PREFIX}/fs/app/${share.appid}/${share.host}`)) {
        i++;
      }
      else {
        this._shares.splice(i, 1);
      }
    }

    return this._binds.map(map => this._makeMount(map)).concat(
      this._files.map(file => this.makeFile(file)),
      this._shares.map(share => this.makeShare(share)),
      this._customshares.map(map => this.makeCustomShare(map))
    ).reduce((a, b) => a.concat(b), []);
  },

  _makeMount: function(bind) {
    FS.mkdirSync(`${this._root}/${bind.host}`, { recursive: true });
    return {
      Type: 'bind',
      Source: Path.normalize(`${this._hostroot}/${bind.host}`),
      Target: this._expand(bind.target),
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  makeFile: function(file) {
    const src = Path.normalize(`${this._root}/${file.host}`);
    FS.mkdirSync(Path.dirname(src), { recursive: true });
    FS.writeFileSync(src, file.data);
    return {
      Type: 'bind',
      Source: Path.normalize(`${this._hostroot}/${file.host}`),
      Target: this._expand(file.target),
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
      Target: this._expand(Path.normalize(`${share.root}/${share.target}`)),
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  makeCustomShare: function(bind) {
    return bind.shares.map((share) => {
      FS.mkdirSync(`${this._root}/${bind.host}/${share.name}`, { recursive: true });
      return {
        Type: 'bind',
        Source: Path.normalize(`${this._hostroot}/${bind.host}/${share.name}`),
        Target: this._expand(Path.normalize(`${bind.target}/${share.name}`)),
        BindOptions: {
          Propagation: 'rshared'
        }
      }
    });
  },

  mapFilenameToLocal: function(filename) {
    for (let i = 0; i < this._binds.length; i++) {
      const bind = this._binds[i];
      if (filename.startsWith(this._expand(bind.target))) {
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
  },

  saveLogs: function(stdout, stderr) {
    FS.mkdirSync(`${this._root}/logs`, { recursive: true });
    FS.writeFileSync(`${this._root}/logs/stdout.txt`, stdout);
    FS.writeFileSync(`${this._root}/logs/stderr.txt`, stderr);
  },

  _expand: function(path) {
    if (path.indexOf('{{') !== -1) {
      const env = this._app._env;
      for (let key in env) {
        path = path.replace(new RegExp(`\{\{${key}\}\}`, 'g'), env[key].value);
      }
    }
    return path;
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
