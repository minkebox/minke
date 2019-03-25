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

const TICK = 10 * 60 * 1000;
const TAG = '.minke-formatted';
const ROOT = process.env.ROOTDISK || 'sda';
const NAME = ROOT === 'sda' ? 'sdb' : ROOT === 'sdb' ? 'sda' : '__unknown__';
const PART = 1;

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
      name: ROOT,
      part: 2,
      size: 0,
      used: 0,
      status: 'ready'
    };

    if (FS.existsSync(`/sys/block/${NAME}`)) {
      this._info.store = {
        style: 'store',
        root: '/mnt/store',
        name: NAME,
        part: PART,
        size: 512 * parseInt(FS.readFileSync(`/sys/block/${NAME}/size`, { encoding: 'utf8' })),
        used: 0,
        status: 'unformatted'
      };

      const info = this._info.store;
      if (FS.existsSync(`/sys/block/${info.name}/${info.name}1`)) {
        this._info.store.status = 'partitioned';
        const mounts = FS.readFileSync('/proc/mounts', { encoding: 'utf8' });
        if (mounts.indexOf(info.root) !== -1 && FS.existsSync(`${info.root}/${TAG}`)) {
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

  _formatDisk: async function(style) {
    const info = this._info[style];
    if (style !== 'store' || !info) {
      throw new Error('Can only format "store" disk');
    }
  
    const disk = `/dev/${info.name}`;

    // If disk isn't mounted, attempt to mount it so we can check to see if we
    // already formatted it.
    const mounts = FS.readFileSync('/proc/mounts', { encoding: 'utf8' });
    if (mounts.indexOf(disk) === -1) {
      ChildProcess.spawnSync('mount', [ info.root ]);
    }
  
    // Must remove the tag to reformat.
    if (FS.existsSync(`${info.root}/${TAG}`)) {
      throw new Error('Disk already formatted');
    }

    info.status = 'formatting';
    
    // Partition and format disk, then tag it.
    const cmds = [
      [ 'umount', [ info.root ]],
      [ 'parted', [ '-s', disk, 'mklabel gpt' ]],
      [ 'parted', [ '-s', '-a', 'opt', disk, 'mkpart store ext4 0% 100%' ]],
      [ 'sh', [ '-c', `mknod -m 0660 ${disk}${info.part} b $(cat /sys/block/${info.name}/${info.name}${info.part}/dev | sed "s/:/ /g")` ]],
      [ 'mkfs.ext4', [ '-F', '-O', '64bit', `${disk}${info.part}`]],
      [ 'mount', [ info.root ]]
    ];
    for (let i = 0; i < cmds.length; i++) {
      await new Promise((resolve) => {
        const cp = ChildProcess.spawn(cmds[i][0], cmds[i][1]);
        //cp.stdout.on('data', (data) => {
        //  console.log(`stdout: ${data}`);
        //});
        //cp.stderr.on('data', (data) => {
        //  console.log(`stderr: ${data}`);
        //});
        cp.on('close', resolve);
      });
    }

    const nmounts = FS.readFileSync('/proc/mounts', { encoding: 'utf8' });
    if (nmounts.indexOf(disk) === -1) {
      // Failed
      info.status = 'unformatted';
    }
    else {
      FS.writeFileSync(`${info.root}/${TAG}`, '');
      info.status = 'ready';
      await this._update();
    }
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
    if (info && info.status === 'ready') {
      return info.root;
    }
    else {
      return this._info.boot.root;
    }
  },

  format: function(style, done) {
    (async () => {
      try {
        await this._formatDisk(style);
      }
      catch (e) {
        console.error(e);
      }
      done();
    })();
  }

}

module.exports = Disks;
