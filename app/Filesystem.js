const FS = require('fs');
const Path = require('path');
const ChildProcess = require('child_process');
const Disks = require('./Disks');
const Flatten = require('./utils/Flatten');
let MinkeApp;

const NATIVE_DIR = '/mnt/native';

process.umask(0);

function _Filesystem(app) {
  this._primaryApp = app;
}

_Filesystem.prototype = {

  getAllMounts: async function(app) {
    const mounts = Flatten([
      await Promise.all(app._binds.map(async map => await this._makeMount(map))),
      await Promise.all(app._files.map(async file => await this._makeFile(app, file)))
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
  unmountAll: async function(app, mounts) {
    // Get list of mount targets
    const paths = (await Promise.all((mounts || []).map(async mount => await this._mapFilenameToLocal(app, mount.Target)))).filter(v => v);
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
    const target = await this._expandString(bind.target);
    const src = await this._expandPathWithDefault(await this._expandString(bind.dir), bind.src);
    const pathset = await this._expandPathSet(bind.target);
    const backupset = await this._expandBackupSet(bind.target);
    const natives = Filesystem.getNativeDirectories()

    const binds = [];
    if (src) {
      FS.mkdirSync(src, { recursive: true, mode: 0o777 });
      binds.push({
        Type: 'bind',
        Source: Filesystem.mapFilenameToNative(src),
        Target: target,
        BindOptions: {
          Propagation: 'rshared'
        }
      });
    }

    for (let i = 0; i < pathset.length; i++) {
      const share = pathset[i];
      // If share has a source which exists, bind it.
      if (share.src) {
        if (MinkeApp.getAppById(share.src.replace(/^.*apps\/([^/]+).*$/,'$1')) && FS.existsSync(share.src)) {
          //FS.mkdirSync(`${target}/${share.name}`, { recursive: true, mode: 0o777 })
          binds.push({
            Type: 'bind',
            Source: Filesystem.mapFilenameToNative(share.src),
            Target: Path.normalize(`${target}/${share.name}`),
            BindOptions: {
              Propagation: 'rshared'
            }
          });
        }
        else if (natives.find(native => native.src === share.src)) {
          //FS.mkdirSync(`${target}/${share.name}`, { recursive: true, mode: 0o777 })
          binds.push({
            Type: 'bind',
            Source: share.src,
            Target: Path.normalize(`${target}/${share.name}`),
            BindOptions: {
              Propagation: 'rshared'
            }
          });
        }
      }
    }

    for (let i = 0; i < backupset.length; i++) {
      const backupApp = MinkeApp.getAppById(backupset[i].appid);
      if (backupApp) {
        await this._addBackups(binds, backupApp, backupApp, target, '');
        for (let j = 0; j < backupApp._secondary.length; j++) {
          await this._addBackups(binds, backupApp, backupApp._secondary[j], target, j);
        }
      }
    }

    return binds;
  },

  _makeFile: async function(app, file) {
    //console.log('_makeFile', file);
    const target = await this._expandString(file.target);
    const data = await this._expandFileWithDefault(target, file.value);

    // If file.target is inside a directory mount, we just create the file inside that
    // and don't mount it seperately.
    let src = file.src;
    for (let i = 0; i < app._binds.length; i++) {
      const bindtarget = await this._expandString(app._binds[i].target);
      if (target.indexOf(bindtarget) === 0 && target[bindtarget.length] === '/') {
        src = `${app._binds[i].src}${target.substring(bindtarget.length)}`;
        // With the 'src' inside a bind, we don't strictly need the bind being returned below,
        // but we'll let the 'removeChildren' filter handle this.
        break;
      }
    }

    FS.mkdirSync(Path.dirname(src), { recursive: true, mode: 0o777 });
    if (data !== null && data !== undefined) {
      FS.writeFileSync(src, data, { mode: ('mode' in file ? file.mode : 0o666) });
    }
    else if (!FS.existsSync(file.src)) {
      FS.writeFileSync(src, '', { mode: ('mode' in file ? file.mode : 0o666) });
    }

    return {
      Type: 'bind',
      Source: Filesystem.mapFilenameToNative(src),
      Target: target,
      BindOptions: {
        Propagation: 'rshared'
      }
    }
  },

  readFromFile: async function(path) {
    try {
      const target = await this._expandString(path);
      let src = null;
      for (let i = 0; i < this._primaryApp._binds.length; i++) {
        const bindtarget = await this._expandString(this._primaryApp._binds[i].target);
        if (target.indexOf(bindtarget) === 0 && target[bindtarget.length] === '/') {
          src = `${this._primaryApp._binds[i].src}${target.substring(bindtarget.length)}`;
          break;
        }
      }
      if (!src) {
        const file = this._primaryApp._files.find(file => file.target === target);
        if (file) {
          src = file.src;
        }
      }
      if (src) {
        return FS.readFileSync(src, { encoding: 'utf8' });
      }
    }
    catch (_) {
    }
    return '';
  },

  _addBackups: async function(binds, main, app, target, ext) {
    const name = main._safeName();
    for (let j = 0; j < app._binds.length; j++) {
      const bind = app._binds[j];
      if (bind.backup) {
        binds.push({
          Type: 'bind',
            Source: Filesystem.mapFilenameToNative(bind.src),
            Target: Path.normalize(`${target}/${name}${ext}/${await main.expandString(bind.target)}`),
            BindOptions: {
              Propagation: 'rshared'
            },
            ReadOnly: true
        });
      }
    }
    for (let j = 0; j < app._files.length; j++) {
      const file = app._files[j];
      if (file.backup) {
        binds.push({
          Type: 'bind',
          Source: Filesystem.mapFilenameToNative(file.src),
          Target: Path.normalize(`${target}/${name}${ext}/${await main.expandString(file.target)}`),
          BindOptions: {
            Propagation: 'rshared'
          },
          ReadOnly: true
        });
      }
    }
  },

  _removeChildren: function(mounts) {
    const valid = [];
    for (let jdx = 0; jdx < mounts.length; jdx++) {
      let outer = mounts[jdx];
      for (let idx = 0; outer && idx < mounts.length; idx++) {
        const inner = mounts[idx];
        if (outer !== inner && outer.Source.indexOf(inner.Source) === 0 && outer.Target.indexOf(inner.Target) === 0) {
          const outerSourceExtra = outer.Source.substring(inner.Source.length);
          const outerTargetExtra = outer.Target.substring(inner.Target.length);
          if (outer.Source[inner.Source.length] === '/' && outer.Target[inner.Target.length] === '/') {
            // Outer is a child of Inner. Its source is a child path and it's target is a child path. - ignore
            outer = null;
          }
        }
      }
      if (outer) {
        valid.push(outer);
      }
    }
    return valid;
  },

  _mapFilenameToLocal: async function(app, filename) {
    for (let i = 0; i < app._binds.length; i++) {
      const bind = app._binds[i];
      if (filename.startsWith(bind.target)) {
        const src = await this._expandPathWithDefault(bind.target, bind.src);
        return Path.normalize(`${src}/${filename.substring(bind.target.length)}`);
      }
    }
    return null;
  },

  uninstall: function() {
    const rmAll = (path) => {
      // Removing file trees can take a while, so we do them in an async external process
      ChildProcess.spawn('/bin/rm', [ '-rf', path ], { cwd: '/tmp', stdio: 'ignore', detached: true });
    };
    rmAll(Filesystem.getNativePath(this._primaryApp._id, 'boot', ''));
    rmAll(Filesystem.getNativePath(this._primaryApp._id, 'store', ''));
  },

  saveLogs: function(stdout, stderr, ext) {
    const root = Filesystem.getNativePath(this._primaryApp._id, 'boot', `/logs${ext}`);
    FS.mkdirSync(root, { recursive: true, mode: 0o777 });
    FS.writeFileSync(`${root}/stdout.txt`, stdout);
    FS.writeFileSync(`${root}/stderr.txt`, stderr);
  },

  _expandString: async function(str) {
    return await this._primaryApp.expandString(str);
  },

  _expandPathWithDefault: async function(path, defaultPath) {
    if (path) {
      const npath = await this._primaryApp.expandPath(path);
      if (npath == path) {
        return defaultPath;
      }
      return npath;
    }
    return defaultPath;
  },

  _expandPathSet: async function(path) {
    return this._primaryApp.expandPathSet(path);
  },

  _expandBackupSet: async function(path) {
    return this._primaryApp.expandBackupSet(path);
  },

  _expandFileWithDefault: async function(path, defaultStr) {
    const str = await this._primaryApp.expandVariable(path);
    if (str !== undefined && str !== null) {
      return String(str);
    }
    return await this._primaryApp.expandString(defaultStr);
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
    if (id === 'temp') {
      return null;
    }
    else {
      return Path.normalize(`${Disks.getRoot(id)}/apps/${appid}/${path}`);
    }
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
