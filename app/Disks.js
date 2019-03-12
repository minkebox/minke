
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

const Disks = {

  _info: null,
  _timer: null,

  init: async function() {
    this._timer = setInterval(async () => {
      await this._update();
    }, TICK);
    return await this._update();
  },

  _update: async function() {
    const dinfo = await DF();
    this._info = dinfo.reduce((acc, disk) => {
      if (disk.filesystem.startsWith('/dev/sd')) {
        const name = disk.filesystem.split('/').slice(-1)[0];
        const style = name === 'sda1' ? 'boot' : 'store';
        acc[style] = {
          style: style,
          root: style === 'boot' ? '/minke' : `/mnt/store`,
          name: name,
          size: disk.size,
          used: disk.used
        };
      }
      return acc;
    }, {});
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
    return (this._info[style || 'store'] || this._info.boot).root;
  }

}

module.exports = Disks;
