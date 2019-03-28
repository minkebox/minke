const DB = require('nedb');
const FS = require('fs');

const DB_PATH = '/minke/db';

function _wrap(fn) {
  return async function(db, ...args) {
    return new Promise((resolve, reject) => {
      args.push((err, val) => {
        if (err) {
          reject(err);
        }
        else {
          resolve(val);
        }
      });
      fn.apply(db, args);
    });
  }
}

const Database = {
  
  init: async function() {
    const DB_APPS = `${DB_PATH}/apps.db`;
    const DB_CONFIG = `${DB_PATH}/config.db`;
    const DB_COMPACT_SEC = 60 * 60 * 24; // Every day

    FS.mkdirSync(DB_PATH, { recursive: true });

    Database._apps = new DB({ filename: DB_APPS, autoload: true });
    Database._apps.persistence.setAutocompactionInterval(DB_COMPACT_SEC * 1000);
    Database._config = new DB({ filename: DB_CONFIG, autoload: true });
    Database._config.persistence.setAutocompactionInterval(DB_COMPACT_SEC * 1000);
  },

  getConfig: async function(id) {
    return await this._findOne(Database._config, { _id: id });
  },

  saveConfig: async function(configJson) {
    await this._update(Database._config, { _id: configJson._id }, configJson, { upsert: true });
  },

  getApps: async function() {
    return await this._find(Database._apps, {});
  },

  saveApp: async function(appJson) {
    await this._update(Database._apps, { _id: appJson._id }, appJson, { upsert: true });
  },

  removeApp: async function(id) {
    await this._remove(Database._apps, { _id: id });
  },

  newAppId: function() {
    return Database._apps.createNewId();
  },

  _find: _wrap(DB.prototype.find),
  _findOne: _wrap(DB.prototype.findOne),
  _insert: _wrap(DB.prototype.insert),
  _update: _wrap(DB.prototype.update),
  _ensureIndex: _wrap(DB.prototype.ensureIndex),
  _remove: _wrap(DB.prototype.remove)
};

module.exports = Database;
