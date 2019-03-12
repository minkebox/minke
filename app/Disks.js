
const DiskInfo = require('@dropb/diskinfo');

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

const Disks = {

  _info: null,

  getInfo: async function() {
    if (DEBUG) {
      this._info = {
        boot: {
          style: 'boot',
          root: '/minke',
          name: 'sda',
          size: 1024 * 1024 * 1024,
          used: 0
        }
      };
    }
    else {
      const dinfo = await DiskInfo();
      this._info = dinfo.reduce((acc, disk) => {
        const name = disk.fstype.split('/').slice(-1)[0];
        const style = name === 'sda' ? 'boot' : 'store';
        acc[type] = {
          style: style,
          root: style === 'boot' ? '/minke' : `/mnt/store`,
          name: name,
          size: disk.size,
          used: disk.used
        };
        return acc;
      }, {});
    }
    return this._info;
  },

  /*
   * Get the rood directory for the storage style requested.
   * If no style is given, we default to 'store' (which is bigger than boot).
   * If 'store' doesn't exists, we use 'boot'.
   */
  getRoot: function(style) {
    if (!this._info) {
      this.getInfo();
    }
    return (this._info[style || 'store'] || this._info.boot).root;
  }

}

module.exports = Disks;
