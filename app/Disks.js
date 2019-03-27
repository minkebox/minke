const FS = require('fs');
const ChildProcess = require('child_process');
const DF = require('@sindresorhus/df');
const MinkeApp = require('./MinkeApp');

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
const BOOT = process.env.ROOTDISK || 'sda';
const STORE = BOOT === 'sda' ? 'sdb' : BOOT === 'sdb' ? 'sda' : '__unknown__';
const BLOCKSIZE = 512;
const DISKS = [ 'sda', 'sdb', 'sdc', 'sdd', 'sde' ];

const Disks = {

  _diskinfo: null,
  _timer: null,
  _names: {},

  init: async function() {
    this._timer = setInterval(async () => {
      await this._update();
    }, TICK);
    await this._initDisks();
    await this._update();
  },

  _initDisks: async function() {

    this._diskinfo = {};

    // Find disks
    DISKS.forEach((diskid) => {
      if (FS.existsSync(`/sys/block/${diskid}`)) {
        const info = {
          name: diskid,
          root: diskid === BOOT ? '/minke': null,
          part: diskid === BOOT ? 2 : 1,
          status: diskid === BOOT ? 'ready' : 'unformatted',
          size: BLOCKSIZE * parseInt(FS.readFileSync(`/sys/block/${diskid}/size`, { encoding: 'utf8' })),
          used: 0
        };
        if (info.status === 'unformatted' && FS.existsSync(`/sys/block/${info.name}/${info.name}${info.part}`)) {
          info.status = 'partitioned';
          if (diskid === STORE) {
            info.root = '/mnt/store';
            const mounts = FS.readFileSync('/proc/mounts', { encoding: 'utf8' })
            if (mounts.indexOf(`/dev/${diskid}${info.part} /mnt/store`) !== -1 && FS.existsSync(`/mnt/store/${MinkeApp.getGlobalID()}`)) {
              info.status = 'ready';
            }
          }
        }
        this._diskinfo[diskid] = info;
      }
    });

    this._names.boot = BOOT;
    if (this._diskinfo[STORE]) {
      this._names.store = STORE;
    }
  },

  _update: async function() {
    for (let id in this._diskinfo) {
      const info = this._diskinfo[id];
      if (info.status === 'ready') {
        try {
          const finfo = await DF.file(this._diskinfo[id].root);
          info.size = finfo.size;
          info.used = finfo.used;
        }
        catch (_) {
        }
      }
    }
  },

  _formatDisk: async function(id) {
    const info = this._diskinfo[id];
    if (!info || info.status === 'ready') {
      throw new Error('Cannot format');
    }
  
    const disk = `/dev/${info.name}`;

    // If disk isn't mounted, attempt to mount it so we can check to see if we
    // already formatted it.
    const mounts = FS.readFileSync('/proc/mounts', { encoding: 'utf8' });
    if (mounts.indexOf(disk) === -1) {
      ChildProcess.spawnSync('mount', [ info.root ]);
    }
  
    // Must remove the tag to reformat.
    if (FS.existsSync(`${info.root}/${MinkeApp.getGlobalID()}`)) {
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
      FS.writeFileSync(`${info.root}/${MinkeApp.getGlobalID()}`, '');
      info.status = 'ready';
      await this._update();
    }
  },

  getInfo: function() {
    return {
      names: this._names,
      diskinfo: this._diskinfo
    };
  },

  /*
   * Get the root directory for the storage id requested.
   * If no style is given, we default to 'store' (which is bigger than boot).
   * If 'store' doesn't exists, we use 'boot'.
   */
  getRoot: function(id) {
    const did = this._names[id || 'store'];
    if (did) {
      const info = this._diskinfo[did];
      if (info && info.status === 'ready') {
        return info.root;
      }
    }
    return this._diskinfo[this._names.boot].root;
  },

  format: function(done) {
    (async () => {
      try {
        await this._formatDisk(this._names.store);
      }
      catch (e) {
        console.error(e);
      }
      done();
    })();
  }

}

module.exports = Disks;
