const FS = require('fs');
const Images = require('./Images');
const Pull = require('./Pull');
const Skeletons = require('./Skeletons');

const TRACER_OUTPUT = '/tmp/tracer.out';
const DEFAULT_TIME = { hour: 3, minute: 0 }; // 3am
let MinkeApp;

const Updater = {

  _updateTimeOfDay: Object.assign({}, DEFAULT_TIME),
  _tick: null,

  start: function() {
    if (!this._tick) {
      this._tick = setTimeout(() => this.updateAll(), this._calcTimeToNextUpdate());
    }
  },

  stop: function() {
    if (this._tick) {
      clearTimeout(this._tick);
      this._tick = null;
    }
  },

  restart: function(config) {
    this._updateTimeOfDay.hour = typeof config.hour === 'number' ? config.hour : DEFAULT_TIME.hour;
    this._updateTimeOfDay.minute = typeof config.minute === 'number' ? config.minute : DEFAULT_TIME.minute;
    this.stop();
    this.start();
  },

  updateAll: async function() {
    this.stop();
    try {
      await this._pruneNetworks();
      await this._pruneImages();
      const updated = await this._updateImages();

      let updateMinke = null;
      const order = Updater._getRestartOrder();
      for (let i = 0; i < order.length; i++) {
        const app = order[i];
        if (updated.indexOf(app) !== -1) {
          if (app._image !== Images.MINKE) {
            try {
              const skel = await Skeletons.loadSkeleton(app.skeletonId(), false);
              if (skel && skel.type != 'local') {
                app.updateFromSkeleton(skel.skeleton, app.toJSON());
              }
              await app.restart('update');
            }
            catch (e) {
              console.error(e);
            }
          }
          else {
            // Leave to the end
            updateMinke = app;
          }
        }
      }

      if (this._checkNativeUpdates()) {
        updateMinke = updateMinke || this._getApps().find(app => app._image === Images.MINKE);
        updateMinke.restart('update-native');
      }
      else if (updateMinke) {
        updateMinke.restart('update');
      }
    }
    catch (e) {
      console.error(e);
    }
    this.start();
  },

  updateApp: async function(app) {
    let updated = false;
    try {
      const appimage = Images.withTag(app._image);
      updated = await Pull.updateImage(appimage);
      if (updated) {
        await Skeletons.updateInternalSkeleton(appimage);
      }
      updated |= await Pull.updateImage(Images.withTag(Images.MINKE_HELPER));
      await Promise.all(app._secondary.map(async secondary => {
        updated |= await Pull.updateImage(Images.withTag(secondary._image));
      }));
    }
    catch (e) {
      console.error(e);
    }

    if (updated) {
      const skel = await Skeletons.loadSkeleton(app.skeletonId(), false);
      if (skel && skel.type != 'local') {
        app.updateFromSkeleton(skel.skeleton, app.toJSON());
      }
    }

    return updated;
  },

  _getApps: function() {
    MinkeApp = MinkeApp || require('./MinkeApp');
    return MinkeApp.getApps();
  },

  _getRestartOrder: function() {
    MinkeApp = MinkeApp || require('./MinkeApp');
    return MinkeApp.getStartupOrder();
  },

  _updateImages: async function() {
    const apps = this._getApps();
    const updates = [];
    const helper = await Pull.updateImage(Images.withTag(Images.MINKE_HELPER));
    // Build a set of updated images and whether we've updated them or not
    const images = {};
    for (let i = 0; i < apps.length; i++) {
      try {
        const pimage = Images.withTag(apps[i]._image);
        if (!(pimage in images)) {
          images[pimage] = await Pull.updateImage(pimage);
          await Skeletons.updateInternalSkeleton(pimage);
        }
        await Promise.all(apps[i]._secondary.map(async secondary => {
          const simage = Images.withTag(secondary._image);
          if (!(simage in images)) {
            images[simage] = await Pull.updateImage(simage);
          }
        }));
      }
      catch (e) {
        console.error(e);
      }
    }
    for (let i = 0; i < apps.length; i++) {
      if (apps[i].isRunning()) {
        if (helper && apps[i]._helperContainer) {
          // Helper updated
          updates.push(apps[i]);
        }
        else if (images[Images.withTag(apps[i]._image)]) {
          // Image updated
          updates.push(apps[i]);
        }
        else if (apps[i]._secondary.reduce((r, secondary) => {
          return r || images[Images.withTag(secondary._image)];
        }, false)) {
          // Secondary updated
          updates.push(apps[i]);
        }
      }
    }
    return updates;
  },

  _pruneImages: async function() {
    try {
      // Simple prune - anything not being used and without a tag
      await docker.pruneImages({});
      // Extra prune - anything not being used, even with a tag, but not a system component
      await docker.pruneImages({
        filters: {
          'label!': [ 'net.minkebox.system' ],
          'dangling': [ 'false' ]
        }
      });
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
