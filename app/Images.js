const Config = require('./Config');

module.exports = {

  MINKE: `${Config.REGISTRY_HOST}/minkebox/minke`,
  MINKE_HELPER: `${Config.REGISTRY_HOST}/minkebox/minke-helper`,
  MINKE_UPDATER: `${Config.REGISTRY_HOST}/minkebox/minke-updater`,

  _overrides: Config.REGISTRY_TAG_OVERRIDES || {},

  withTag: function (name) {
    if (name.indexOf(':') !== -1) {
      return name;
    }
    else {
      return `${name}:${this._overrides[name] || Config.REGISTRY_DEFAULT_TAG}`;
    }
  }
};
