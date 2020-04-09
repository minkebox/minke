module.exports = {
  ROOT: '/minke',
  CONFIG_NAME: 'Development',
  WEB_PORT: 80,
  REGISTRY_HOST: 'registry.minkebox.net',
  REGISTRY_DEFAULT_TAG: 'latest',
  REGISTRY_TAG_OVERRIDES: {
    'registry.minkebox.net/minkebox/minke': 'dev',
    'registry.minkebox.net/minkebox/minke-helper': 'dev'
  },
  DDNS_UPDATE: 'https://ddns.minkebox.net/update',
  GLOBALDOMAIN: '.minkebox.net',
  DEFAULT_FALLBACK_RESOLVER: '1.1.1.1'
};
