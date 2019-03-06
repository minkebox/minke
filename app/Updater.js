const Images = require('./Images');
const Pull = require('./Pull');

let MinkeApp;

const Updater = {

  _updateTimeOfDay: { hour: 3, minute: 0 }, // 3am
  _tick: null,

  start: function() {
    if (!this._tick) {
      const update = async () => {
        this._tick = setTimeout(update, this._calcTimeToNextUpdate());
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
        if (updateMinke) {
          updateMinke.restart('update');
        }
      }
      const timer = this._calcTimeToNextUpdate();
      this._tick = setTimeout(update, timer);
    }
  },

  stop: function() {
    if (this._tick) {
      clearTimeout(this._tick);
      this._tick = null;
    }
  },

  _updateImages: async function() {
    MinkeApp = MinkeApp || require('./MinkeApp');
    const apps = MinkeApp.getApps();
    const updates = [];
    for (let i = 0; i < apps.length; i++) {
      try {
        if (await Pull.updateImage(apps[i]._image)) {
          // Image was updated
          updates.push(apps[i]);
        }
      }
      catch (e) {
        console.error(e);
      }
    }
    // Update the helper, but we won't update any app if it changes
    await Pull.updateImage(Images.MINKE_HELPER);
    return updates;
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
  }

}

module.exports = Updater;
