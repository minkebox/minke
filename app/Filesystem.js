const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');
const Disks = require('./Disks');
const Flatten = require('./utils/Flatten');
let MinkeApp;

process.umask(0);

function _Filesystem(app) {
  this._app = app;
}

_Filesystem.prototype = {

  getAllMounts: function(app) {
    const mounts = Flatten([
      app._binds.map(map => this._makeMount(map)),
      app._files.map(file => this.makeFile(file)),
      app._backups.map(backup => this._makeBackups(backup))
    ]);

    // Remove any internal child mounts
    const nmounts = this._removeChildren(mounts);

    //console.log('getAllMounts', nmounts);
    return nmounts;
  },

  //
  // Docker should remove any mounts as it shuts down a container. However, if there's any mount-in-mount going
  // on it has a habit of not tidying things up properly. Do that here.
  //
  unmountAll: function(mounts) {
    // Get list of mount targets
    const paths = mounts.map(mount => this.mapFilenameToLocal(mount.Target)).filter(v => v);
    // Sort longest to shortest
    paths.sort((a, b) => b.length - a.length);
    //console.log('unmountAll', paths);
    paths.forEach(path => {
      try {
        ChildProcess.spawnSync('/bin/umount', [ path ], { cwd: '/tmp', stdio: 'ignore' });
      }
      catch (_) {
      }
    });
  },

  _makeMount: function(bind) {
    //console.log('_makeMount', bind);
    if (bind.src) {
      FS.mkdirSync(bind.src, { recursive: true, mode: 0o777 });
      bind.shares.forEach(share => FS.mkdirSync(`${bind.src}/${share.name}`, { recursive: true, mode: 0o777 }));
    }

    const binds = [];
    if (bind.src) {
      binds.push({
        Type: 'bind',
        Source: Filesystem.mapFilenameToNative(bind.src),
        Target: this._expand(bind.target),
        BindOptions: {
          Propagation: 'rshared'
        }
      });
    }
    bind.shares.forEach(share => {
      // If share has a source which exists, bind it.
      if (share.src && MinkeApp.getAppById(share.src.replace(/^.*apps\/([^/]+).*$/,'$1')) && FS.existsSync(share.src)) {
        binds.push({
          Type: 'bind',
          Source: Filesystem.mapFilenameToNative(share.src),
          Target: Path.normalize(this._expand(`${bind.target}/${share.name}`)),
          BindOptions: {
            Propagation: 'rshared'
          }
        });
      }
    });
    return binds;
  },

  makeFile: function(file) {
    //console.log('makeFile', file);
    FS.mkdirSync(Path.dirname(file.src), { recursive: true, mode: 0o777 });
    FS.writeFileSync(file.src, file.data, { mode: ('mode' in file ? file.mode : 0o666) });
    return {
      Type: 'bind',
      Source: Filesystem.mapFilenameToNative(file.src),
      Target: this._expand(file.target),
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  readFile: function(file) {
    //console.log('readFile', file);
    file.data = FS.readFileSync(file.src, { encoding: 'utf8' });
  },

  _makeBackups: function(backup) {
    const backups = [];
    const mainApp = MinkeApp.getAppById(backup.appid);
    if (mainApp) {
      const name = mainApp._safeName();
      const addBackups = (app, ext) => {
        app._binds.forEach(bind => {
          if (bind.backup) {
            backups.push({
              Type: 'bind',
              Source: Filesystem.mapFilenameToNative(bind.src),
              Target: Path.normalize(this._expand(`${backup.target}/${name}${ext}/${bind.target}`)),
              BindOptions: {
                Propagation: 'rshared'
              },
              ReadOnly: true
            });
          }
        });
        app._files.forEach(bind => {
          if (bind.backup) {
            backups.push({
              Type: 'bind',
              Source: Filesystem.mapFilenameToNative(bind.src),
              Target: Path.normalize(this._expand(`${backup.target}/${name}${ext}/${bind.target}`)),
              BindOptions: {
                Propagation: 'rshared'
              },
              ReadOnly: true
            });
          }
        });
      }
      addBackups(mainApp, '');
      mainApp._secondary.forEach((secondary, idx) => addBackups(secondary, `__${idx}`));
    }
    return backups;
  },

  _removeChildren: function(mounts) {
    const valid = [];
    for (let jdx = 0; jdx < mounts.length; jdx++) {
      let outer = mounts[jdx];
      for (let idx = 0; outer && idx < mounts.length; idx++) {
        const inner = mounts[idx];
        if (outer !== inner && outer.Source.indexOf(inner.Source) === 0 && outer.Target.indexOf(inner.Target) === 0) {
          // Outer is a child of Inner. Its source is a child path and it's target is a child path. - ignore
          outer = null;
        }
      }
      if (outer) {
        valid.push(outer);
      }
    }
    return valid;
  },

  mapFilenameToLocal: function(filename) {
    for (let i = 0; i < this._app._binds.length; i++) {
      const bind = this._app._binds[i];
      const target = this._expand(bind.target);
      if (filename.startsWith(target)) {
        return Path.normalize(`${bind.src}/${filename.substring(target.length)}`);
      }
    }
    return null;
  },

  uninstall: function() {
    const rmAll = (path) => {
      // Removing file trees can take a while, so we do them in an async external process
      ChildProcess.spawn('/bin/rm', [ '-rf', path ], { cwd: '/tmp', stdio: 'ignore', detached: true });
    };
    rmAll(Filesystem.getNativePath(this._app._id, 'boot', ''));
    rmAll(Filesystem.getNativePath(this._app._id, 'store', ''));
  },

  saveLogs: function(stdout, stderr, ext) {
    const root = Filesystem.getNativePath(this._app._id, 'boot', `/logs${ext}`);
    FS.mkdirSync(root, { recursive: true, mode: 0o777 });
    FS.writeFileSync(`${root}/stdout.txt`, stdout);
    FS.writeFileSync(`${root}/stderr.txt`, stderr);
  },

  _expand: function(path) {
    return this._app.expand(path);
  }

}

const Filesystem = {

  _mappings: {},

  init: async function() {
    MinkeApp = MinkeApp || require('./MinkeApp');
    const info = await MinkeApp._container.inspect();
    info.HostConfig.Mounts.forEach(mount => {
      if (mount.Type === 'bind' && mount.Target !== mount.Source) {
        Filesystem._mappings[mount.Target] = mount.Source;
      }
    });
  },

  create: function(app) {
    return new _Filesystem(app);
  },

  getNativePath: function(appid, id, path) {
    return Path.normalize(`${Disks.getRoot(id)}/apps/${appid}/${path}`);
  },

  mapFilenameToNative: function(filename) {
    for (let prefix in Filesystem._mappings) {
      if (filename.indexOf(prefix) === 0) {
        return `${Filesystem._mappings[prefix]}${filename.substring(prefix.length)}`;
      }
    }
    return filename;
  }

};

module.exports = Filesystem;
