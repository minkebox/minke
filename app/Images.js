const Config = require('./Config');

module.exports = {

  MINKE: `${Config.REGISTRY_HOST}/minkebox/minke`,
  MINKE_HELPER: `${Config.REGISTRY_HOST}/minkebox/minke-helper`,
  MINKE_PRIVATE_NETWORK: `${Config.REGISTRY_HOST}/minkebox/privatenetwork`,

  withTag: function (name) {
    if (name.indexOf(':') === -1) {
      return `${name}:${Config.REGISTRY_DEFAULT_TAG}`;
    }
    else {
      return name;
    }
  }
};
