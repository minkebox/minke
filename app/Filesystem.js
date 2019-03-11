const FS = require('fs');
const Path = require('path');
const Disks = require('./Disks');

process.umask(0);


function Filesystem(app) {
  this._app = app;
  this._binds = app._binds;
  this._files = app._files;
  this._shares = app._shares;
  this._customshares = app._customshares;
}

Filesystem.prototype = {

  getAllMounts: function() {

    // Remove any broken shares (in case an app was uninstalled)
    for (let i = 0; i < this._shares.length; ) {
      const share = this._shares[i];
      if (FS.existsSync(`${Disks.getRoot(share.style)}/boot/${share.appid}/${share.host}`)) {
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
    const src = Path.normalize(`${this._getRoot(bind.style)}/${bind.host}`);
    FS.mkdirSync(src, { recursive: true });
    return {
      Type: 'bind',
      Source: src,
      Target: this._expand(bind.target),
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  makeFile: function(file) {
    const src = Path.normalize(`${this._getRoot(file.style)}/${file.host}`);
    FS.mkdirSync(Path.dirname(src), { recursive: true });
    FS.writeFileSync(src, file.data);
    return {
      Type: 'bind',
      Source: src,
      Target: this._expand(file.target),
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  readFile: function(file) {
    const src = Path.normalize(`${this._getRoot(file.style)}/${file.host}`);
    file.data = FS.readFileSync(src, { encoding: 'utf8' });
  },

  makeShare: function(share) {
    const src = Path.normalize(`${Disks.getRoot(share.style)}/boot/${share.appid}/${share.host}`);
    return {
      Type: 'bind',
      Source: src,
      Target: this._expand(Path.normalize(`${share.root}/${share.target}`)),
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  makeCustomShare: function(bind) {
    return bind.shares.map((share) => {
      const src = Path.normalize(`${this._getRoot(bind.style)}/${bind.host}/${share.name}`);
      FS.mkdirSync(src, { recursive: true });
      return {
        Type: 'bind',
        Source: src,
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
        return Path.normalize(`${this._getRoot(bind.style)}/${bind.host}/${filename.substring(bind.target.length)}`);
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
    rmAll(this._getRoot('boot'));
    rmAll(this._getRoot('store'));
  },

  saveLogs: function(stdout, stderr) {
    const root = this._getRoot('boot');
    FS.mkdirSync(`${root}/logs`, { recursive: true });
    FS.writeFileSync(`${root}/logs/stdout.txt`, stdout);
    FS.writeFileSync(`${root}/logs/stderr.txt`, stderr);
  },

  _getRoot: function(style) {
    return `${Disks.getRoot(style)}/boot/${this._app._id}`;
  },

  _expand: function(path) {
    return this._app.expand(path);
  }

}

const _Filesystem = {

  create: function(app) {
    return new Filesystem(app);
  }

};

module.exports = _Filesystem;
