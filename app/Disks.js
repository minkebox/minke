const FS = require('fs');
const ChildProcess = require('child_process');
const DF = require('@sindresorhus/df');

/*
 * Disk structure:
 * /minke
 *       /db/...            Databases
 *       /apps
 *            /<id>/...     Application data (boot)
 * /mnt
 *     /store
 *           /apps
 *                /<id>/... Application data needing large disk (store)
 */

const TICK = 60 * 60 * 1000;
const TAG = '.minke-formatted';

const Disks = {

  _info: null,
  _timer: null,

  init: async function() {
    this._timer = setInterval(async () => {
      await this._update();
    }, TICK);
    await this._initDisks();
    await this._update();
  },

  _initDisks: async function() {
    this._info = {};

    this._info.boot = {
      style: 'boot',
      root: '/minke',
      name: 'sda',
      size: 0,
      used: 0,
      status: 'ready'
    };

    const name = 'sdb';
    if (FS.existsSync(`/sys/block/${name}`)) {
      this._info.store = {
        style: 'store',
        root: '/mnt/store',
        name: name,
        size: 512 * parseInt(FS.readFileSync(`/sys/block/${name}/size`, { encoding: 'utf8' })),
        used: 0,
        status: 'unformatted'
      };

      const info = this._info.store;
      if (FS.existsSync(`/sys/block/${info.name}/${info.name}1`)) {
        this._info.store.status = 'partitioned';
        if (FS.existsSync(`${info.root}/${TAG}`)) {
          this._info.store.status = 'ready';
        }
      }
    }
  },

  _update: async function() {
    for (let style in this._info) {
      if (this._info[style].status === 'ready') {
        try {
          const finfo = await DF.file(this._info[style].root);
          this._info[style].size = finfo.size;
          this._info[style].used = finfo.used;
        }
        catch (_) {
        }
      }
    }
  },

  _formatDisk: function(style) {
    const info = this._info[style];
    if (style !== 'store' || !info) {
      throw new Error('Can only format "store" disk');
    }
  
    const disk = `/dev/${info.name}`;
    const part = 1;

    // If disk isn't mounted, attempt to mount it so we can check to see if we
    // already formatted it.
    const mounts = FS.readFileSync('/proc/mounts', { encoding: 'utf8' });
    if (mounts.indexOf(disk) === -1) {
      ChildProcess.spawnSync('mount', [ disk ]);
    }
  
    // Must remove the tag to reformat.
    if (FS.existsSync(`${info.root}/${TAG}`)) {
      throw new Error('Disk already formatted');
    }
    
    // Partition and format disk, then tag it.
    const cmds = [
      [ 'umount', [ disk ]],
      [ 'parted', [ '-s', disk, 'mklabel gpt' ]],
      [ 'parted', [ '-s', '-a', 'opt', disk, 'mkpart store ext4 0% 100%' ]],
      [ 'mkfs.ext4', [ '-F', `${disk}${part}`]],
      [ 'mount', [ disk ]]
    ];
    cmds.forEach((cmd) => {
      ChildProcess.spawnSync(cmd[0], cmd[1]);
    });
    FS.writeFileSync(`${info.root}/${TAG}`, '');
  },

  getInfo: function() {
    return this._info;
  },

  /*
   * Get the rood directory for the storage style requested.
   * If no style is given, we default to 'store' (which is bigger than boot).
   * If 'store' doesn't exists, we use 'boot'.
   */
  getRoot: function(style) {
    const info = this._info[style || 'store'];
    if (info && info.formatted) {
      return info.root;
    }
    else {
      return this._info.boot.root;
    }
  }

}

module.exports = Disks;
