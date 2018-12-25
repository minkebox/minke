const DB = require('nedb');
const FS = require('fs');

const DB_PATH = process.env.DEBUG ? '/tmp/minke/db' : '/minke/db';
const DB_APPS = `${DB_PATH}/apps.db`;
const DB_SHARES = `${DB_PATH}/shares.db`;
const DB_COMPACT_SEC = 60 * 60 * 24; // Every day

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
    FS.mkdirSync(DB_PATH, { recursive: true });

    Database._apps = new DB({ filename: DB_APPS, autoload: true });
    Database._apps.persistence.setAutocompactionInterval(DB_COMPACT_SEC * 1000);
    await this._ensureIndex(Database._apps, { fieldName: 'name', unique: true });

    Database._shares = new DB({ filename: DB_SHARES, autoload: true });
    Database._shares.persistence.setAutocompactionInterval(DB_COMPACT_SEC * 1000);
  },

  getApps: async function() {
    return this._find(Database._apps, {});
  },

  saveApp: async function(app) {
    const json = app.toJSON();
    if (await this._findOne(Database._apps, { name: json.name })) {
      await this._update(Database._apps, { name: json.name }, json);
    }
    else {
      await this._insert(Database._apps, json);
    }
  },

  _find: _wrap(DB.prototype.find),
  _findOne: _wrap(DB.prototype.findOne),
  _insert: _wrap(DB.prototype.insert),
  _update: _wrap(DB.prototype.update),
  _ensureIndex: _wrap(DB.prototype.ensureIndex)
};

module.exports = Database;
