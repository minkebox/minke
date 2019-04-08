const DEFAULT_TAG = (process.env.TAG ? process.env.TAG : 'latest');

module.exports = {

  MINKE: 'registry.minkebox.net/minkebox/minke',
  MINKE_HELPER: 'registry.minkebox.net/minkebox/minke-helper',
  MINKE_PRIVATE_NETWORK: 'registry.minkebox.net/minkebox/privatenetwork',

  withTag: function (name) {
    if (name.indexOf(':') === -1) {
      return `${name}:${DEFAULT_TAG}`;
    }
    else {
      return name;
    }
  }
};