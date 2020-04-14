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

const BOOT_PATH = '/minke';
const STORE_PATH = '/mnt/store';
const TAG = '.minke-formatted';
const BLOCKSIZE = 512;
const DISKS = [
  BOOT_PATH, [ 'sda', 'mmcblk0' ],
  STORE_PATH, [ 'sdb', 'sdc', 'sdd', 'sde', 'mmcblk1', 'mmcblk2' ]
];
const PART = 1;
const NOSYSTEM = {
  BOOT_PATH: {
    name: BOOT_PATH,
    size: 0,
    used: 0,
    root: BOOT_PATH,
    status: 'ready',
  },
  STORE_PATH: {
    name: STORE_PATH,
    size: 0,
    used: 0,
    root: STORE_PATH,
    status: 'ready'
  }
};

const Disks = {

  _diskinfo: {},
  _timer: null,

  init: async function() {
    if (SYSTEM) {
      this._initDisks();
    }
    else {
      await this._initNoSystemDisks();
    }
    await this._update();
  },

  _initDisks: function() {
    // Locate the disks which could be BOOT and STORE
    for (let did = 0; did < DISKS.length; did += 2) {
      const diskroot = DISKS[did + 0];
      const possibles = DISKS[did + 1];
      for (let p = 0; p < possibles.length; p++) {
        // Look through possible matches until we find one that exists
        const diskid = possibles[p];
        if (FS.existsSync(`/sys/block/${diskid}`)) {
          const info = {
            name: diskid,
            size: BLOCKSIZE * parseInt(FS.readFileSync(`/sys/block/${diskid}/size`, { encoding: 'utf8' })),
            used: 0
          };
          switch (diskroot) {
            case BOOT_PATH:
              info.root = diskroot;
              info.status = 'ready';
              break;
            case STORE_PATH:
              FS.mkdirSync(diskroot, { recursive: true });
              ChildProcess.spawnSync('mount', [ `/dev/${this._partName(diskid, PART)}`, diskroot ]);
              if (FS.existsSync(`${diskroot}/${TAG}`)) {
                info.root = diskroot;
                info.status = 'ready';
              }
              else {
                ChildProcess.spawnSync('umount', [ info.root ]);
              }
              break;
            default:
              this._diskinfo[diskid].status = 'unknown';
              break;
          }
          this._diskinfo[diskid] = info;
          break;
        }
      }
    }
  },

  _initNoSystemDisks: async function() {
    for (let id in NOSYSTEM) {
      try {
        const info = FS.statSync(NOSYSTEM[id].root);
        if (info.isDirectory()) {
          this._diskinfo[id] = NOSYSTEM[id];
        }
      }
      catch (_) {
      }
    }
  },

  _update: async function() {
    for (let id in this._diskinfo) {
      const info = this._diskinfo[id];
      if (info.root) {
        try {
          const finfo = await DF.file(info.root);
          info.size = finfo.size;
          info.used = finfo.used;
        }
        catch (_) {
        }
      }
    }
  },

  _formatDisk: async function(info) {

    if (!info || info.status === 'ready') {
      throw new Error('Cannot format');
    }

    // If disk isn't mounted, attempt to mount it so we can check to see if we
    // already formatted it.
    const mounts = FS.readFileSync('/proc/mounts', { encoding: 'utf8' });
    if (mounts.indexOf(`/dev/${info.name}`) === -1) {
      ChildProcess.spawnSync('mount', [ `/dev/${this._partName(info.name, PART)}`, info.root ]);
    }

    // Must remove the tag to reformat.
    if (FS.existsSync(`${info.root}/${TAG}`)) {
      throw new Error('Disk already formatted');
    }

    info.status = 'formatting';

    // Partition and format disk, then tag it.
    const cmds = [
      [ 'umount', [ info.root ]],
      [ 'parted', [ '-s', `/dev/${info.name}`, 'mklabel gpt' ]],
      [ 'parted', [ '-s', '-a', 'opt', `/dev/${info.name}`, 'mkpart store ext4 0% 100%' ]],
      [ 'sh', [ '-c', `mknod -m 0660 /dev/${this._partName(info.name, PART)} b $(cat /sys/block/${info.name}/${this._partName(info.name, PART)}/dev | sed "s/:/ /g")` ]],
      [ 'mkfs.ext4', [ '-F', '-O', '64bit', `/dev/${this._partName(info.name, PART)}`]],
      [ 'mkdir', [ '-p', info.root ]],
      [ 'mount', [ `/dev/${this._partName(info.name, PART)}`, info.root ]]
    ];
    for (let i = 0; i < cmds.length; i++) {
      await new Promise((resolve) => {
        const cp = ChildProcess.spawn(cmds[i][0], cmds[i][1]);
        //console.log('cmd', cmds[i]);
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
    if (nmounts.indexOf(`/dev/${info.name}`) === -1) {
      // Failed
      info.status = 'unformatted';
    }
    else {
      FS.writeFileSync(`${info.root}/${TAG}`, '');
      info.status = 'ready';
      await this._update();
    }
  },

  getAllDisks: async function() {
    await this._update();
    return {
      diskinfo: this._diskinfo
    };
  },

  /*
   * Get the root directory for the storage id requested.
   * If no style is given, we default to 'store' (which is bigger than boot).
   * If 'store' doesn't exists, we use 'boot'.
   */
  getRoot: function(id) {
    const path = id === 'boot' ? BOOT_PATH : STORE_PATH;
    const info = Object.values(this._diskinfo).find(info => info.root == path);
    if (info && info.status === 'ready') {
      return path;
    }
    else {
      return BOOT_PATH;
    }
  },

  /*
   * Format a disk ane make it the STORE.
   */
  format: function(diskid, done) {
    (async () => {
      try {
        const info = this._diskinfo[diskid];
        if (info) {
          info.root = STORE_PATH;
          await this._formatDisk(info);
          if (info.status !== 'ready') {
            info.root = null;
          }
        }
      }
      catch (e) {
        console.error(e);
      }
      done();
    })();
  },

  _partName: function(disk, part) {
    if (disk.startsWith('mmcblk')) {
      return `${disk}p${part}`;
    }
    else {
      return `${disk}${part}`;
    }
  }

}

module.exports = Disks;
