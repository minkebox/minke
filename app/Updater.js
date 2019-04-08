const FS = require('fs');
const Images = require('./Images');
const Pull = require('./Pull');

const TRACER_OUTPUT = '/tmp/tracer.out';
const DEFAULT_TIME = { hour: 3, minute: 0 }; // 3am
let MinkeApp;

const Updater = {

  _updateTimeOfDay: Object.assign({}, DEFAULT_TIME),
  _tick: null,

  start: function() {
    if (!this._tick) {
      const update = async () => {
        try {
          this._tick = setTimeout(update, this._calcTimeToNextUpdate());
          await this._pruneNetworks();
          await this._pruneImages();
          const updated = await this._updateImages();
          let updateMinke = null;
          await Promise.all(updated.map(async (app) => {
            if (app._image !== Images.MINKE) {
              await app.restart('update');
            }
            else {
              // Leave to the end
              updateMinke = app;
            }
          }));
          if (this._checkNativeUpdates()) {
            this._getApps().find(app => app._image === Images.MINKE).restart('update-native');
          }
          else if (updateMinke) {
            updateMinke.restart('update');
          }
        }
        catch (e) {
          console.error(e);
        }
      }
      this._tick = setTimeout(update, this._calcTimeToNextUpdate());
    }
  },

  stop: function() {
    if (this._tick) {
      clearTimeout(this._tick);
      this._tick = null;
    }
  },

  restart: function(config) {
    this._updateTimeOfDay.hour = config.hour || DEFAULT_TIME.hour;
    this._updateTimeOfDay.minute = config.minute || DEFAULT_TIME.minute;
    this.stop();
    this.start();
  },

  _getApps: function() {
    MinkeApp = MinkeApp || require('./MinkeApp');
    return MinkeApp.getApps();
  },

  _updateImages: async function() {
    const apps = this._getApps();
    const updates = [];
    const helper = await Pull.updateImage(Images.withTag(Images.MINKE_HELPER));
    for (let i = 0; i < apps.length; i++) {
      try {
        let updated = await Pull.updateImage(Images.withTag(apps[i]._image));
        await Promise.all(apps[i]._secondary.map(async secondary => {
          updated |= await Pull.updateImage(Images.withTag(secondary._image));
        }));
        if (apps[i].isRunning() && (updated || (helper && apps[i]._helperContainer))) {
          // Image or helper was updated
          updates.push(apps[i]);
        }
      }
      catch (e) {
        console.error(e);
      }
    }
    return updates;
  },

  _pruneImages: async function() {
    try {
      await docker.pruneImages({});
    }
    catch (e) {
      console.error(e);
    }
  },

  _pruneNetworks: async function() {
    try {
      await docker.pruneNetworks({});
    }
    catch (e) {
      console.log(e);
    }
  },

  _calcTimeToNextUpdate: function() {
    const date = new Date();
    date.setMilliseconds(0);
    date.setSeconds(0);
    date.setMinutes(this._updateTimeOfDay.minute);
    date.setHours(this._updateTimeOfDay.hour);
    const millis = date.getTime();
    const now = Date.now();
    if (millis > now) {
      return millis - now;
    }
    else {
      date.setDate(date.getDate() + 1);
      return date.getTime() - now;
    }
  },

  _checkNativeUpdates: function() {
    try {
      const info = FS.readFileSync(TRACER_OUTPUT, { encoding: 'utf8' });
      if (info.trim() != '') {
        return true;
      }
    }
    catch (_) {
    }
    return false;
  }

}

module.exports = Updater;
