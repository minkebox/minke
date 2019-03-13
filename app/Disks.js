const FS = require('fs');
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
    const info = {};
    await Promise.all([ 'a', 'b' ].map(async (letter) => {
      if (FS.existsSync(`/sys/block/sd${letter}`)) {
        let style = null;
        let root = null;
        let name = `sd${letter}`;
        let partition = null;
        switch (letter) {
          case 'a':
            style = 'boot';
            root = '/minke';
            partition = `/dev/sd${letter}2`;
            break;

          case 'b':
            style = 'store';
            root = `/mnt/${style}`;
            partition = `/dev/sd${letter}1`;
            break;

          default:
            break;
        }
        if (style) {
          let finfo = { size: 1, used: 1 };
          try {
            finfo = await DF.file(partition);
          }
          catch (_) {
            finfo = {
              size: 512 * parseInt(FS.readFileSync(`/sys/block/sd${letter}/size`, { encoding: 'utf8' })),
              used: 0,
            }
          }
          info[style] = {
            style: style,
            root: root,
            name: name,
            size: finfo.size,
            used: finfo.used,
            formatted: FS.existsSync(partition)
          };
        }
      }
    }));
    this._info = info;
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
