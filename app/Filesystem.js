const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');
const Disks = require('./Disks');
const Flatten = require('./utils/Flatten');
let MinkeApp;

const NATIVE_DIR = '/mnt/native';

process.umask(0);

function _Filesystem(app) {
  this._app = app;
}

_Filesystem.prototype = {

  getAllMounts: async function(app) {
    const mounts = Flatten([
      await Promise.all(app._binds.map(async map => await this._makeMount(map))),
      await Promise.all(app._files.map(async file => await this.makeFile(file))),
      await Promise.all(app._backups.map(async backup => await this._makeBackups(backup)))
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
  unmountAll: async function(mounts) {
    // Get list of mount targets
    const paths = (await Promise.all(mounts.map(async mount => await this._mapFilenameToLocal(mount.Target)))).filter(v => v);
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

  _makeMount: async function(bind) {
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
        Target: await this._expand(bind.target),
        BindOptions: {
          Propagation: 'rshared'
        }
      });
    }
    const natives = Filesystem.getNativeDirectories();
    await Promise.all(bind.shares.map(async share => {
      // If share has a source which exists, bind it.
      if (share.src) {
        if (MinkeApp.getAppById(share.src.replace(/^.*apps\/([^/]+).*$/,'$1')) && FS.existsSync(share.src)) {
          binds.push({
            Type: 'bind',
            Source: Filesystem.mapFilenameToNative(share.src),
            Target: Path.normalize(await this._expand(`${bind.target}/${share.name}`)),
            BindOptions: {
              Propagation: 'rshared'
            }
          });
        }
        else if (natives.find(native => native.src === share.src)) {
          binds.push({
            Type: 'bind',
            Source: share.src,
            Target: Path.normalize(await this._expand(`${bind.target}/${share.name}`)),
            BindOptions: {
              Propagation: 'rshared'
            }
          });
        }
      }
    }));
    return binds;
  },

  makeFile: async function(file) {
    //console.log('makeFile', file);
    FS.mkdirSync(Path.dirname(file.src), { recursive: true, mode: 0o777 });
    FS.writeFileSync(file.src, file.data, { mode: ('mode' in file ? file.mode : 0o666) });
    return {
      Type: 'bind',
      Source: Filesystem.mapFilenameToNative(file.src),
      Target: await this._expand(file.target),
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  readFile: function(file) {
    //console.log('readFile', file);
    file.data = FS.readFileSync(file.src, { encoding: 'utf8' });
  },

  _makeBackups: async function(backup) {
    const backups = [];
    const mainApp = MinkeApp.getAppById(backup.appid);
    if (mainApp) {
      const name = mainApp._safeName();
      const addBackups = async (app, ext) => {
        await Promise.all(app._binds.map(async bind => {
          if (bind.backup) {
            backups.push({
              Type: 'bind',
              Source: Filesystem.mapFilenameToNative(bind.src),
              Target: Path.normalize(await this._expand(`${backup.target}/${name}${ext}/${bind.target}`)),
              BindOptions: {
                Propagation: 'rshared'
              },
              ReadOnly: true
            });
          }
        }));
        await Promise.all(app._files.map(async bind => {
          if (bind.backup) {
            backups.push({
              Type: 'bind',
              Source: Filesystem.mapFilenameToNative(bind.src),
              Target: Path.normalize(await this._expand(`${backup.target}/${name}${ext}/${bind.target}`)),
              BindOptions: {
                Propagation: 'rshared'
              },
              ReadOnly: true
            });
          }
        }));
      }
      await addBackups(mainApp, '');
      await Promise.all(mainApp._secondary.map(async (secondary, idx) => await addBackups(secondary, `__${idx}`)));
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

  _mapFilenameToLocal: async function(filename) {
    for (let i = 0; i < this._app._binds.length; i++) {
      const bind = this._app._binds[i];
      const target = await this._expand(bind.target);
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

  _expand: async function(path) {
    return await this._app.expand(path);
  }

}

const Filesystem = {

  _mappings: {},
  _natives: [],

  init: async function() {
    MinkeApp = MinkeApp || require('./MinkeApp');
    const info = await MinkeApp._container.inspect();
    info.Mounts.forEach(mount => {
      if (mount.Type === 'bind') {
        this._mappings[mount.Destination] = { src: mount.Source, dst: mount.Destination, propagation: mount.Propagation };
        if (mount.Destination.indexOf(NATIVE_DIR) === 0 && FS.statSync(mount.Destination).isDirectory()) {
          this._natives.push(this._mappings[mount.Destination]);
        }
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
        return `${Filesystem._mappings[prefix].src}${filename.substring(prefix.length)}`;
      }
    }
    return filename;
  },

  getNativeMappings: function() {
    return Filesystem._mappings;
  },

  getNativeDirectories: function() {
    return this._natives;
  }

};

module.exports = Filesystem;
