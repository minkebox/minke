const FS = require('fs');
const Config = require('./Config');
const Images = require('./Images');
const DNS = require('./DNS');
const Network = require('./Network');
const Database = require('./Database');
const MDNS = require('./MDNS');
const UPNP = require('./UPNP');
const MinkeApp = require('./MinkeApp');
const Updater = require('./Updater');
const DDNS = require('./DDNS');
const Human = require('./Human');
const Filesystem = require('./Filesystem');
const Pull = require('./Pull');

const RESTART_REASON = `${Config.ROOT}/minke-restart-reason`;


function MinkeSetup(savedConfig, firstUseConfig, defaultConfig) {

  if (savedConfig) {
    this._bootcount = 1;
  }
  else {
    this._bootcount = 0;
    savedConfig = Object.assign({}, firstUseConfig);
  }

  /*function getEnv(name) {
    return { value: savedConfig[name] || defaultConfig[name] };
  }*/
  const makeVar = (name) => {
    this._vars[name] = { type: 'String', value: savedConfig[name] || defaultConfig[name] };
  }

  this._id = 'minke';
  this._image = Images.MINKE;
  this._status = 'running';
  this._features = {};
  this._binds = [];
  this._files = [{
    src: `${Config.ROOT}/minkebox.config`,
    target: '/minkebox.config',
    data: '',
    mode: 0o600,
    backup: true
  }];
  this._vars = {};
  makeVar('LOCALDOMAIN');
  makeVar('DHCP');
  makeVar('PORT');
  makeVar('IPADDRESS');
  makeVar('NETMASK');
  makeVar('GATEWAY');
  makeVar('IP6');
  makeVar('NATIP6');
  makeVar('WIFIENABLED');
  makeVar('WIFINAME');
  makeVar('WIFIPASSWORD');
  makeVar('DNSSERVER1');
  makeVar('DNSSERVER2');
  makeVar('TIMEZONE');
  makeVar('ADMINMODE');
  makeVar('GLOBALID');
  makeVar('UPDATETIME');
  makeVar('HUMAN');
  makeVar('HOSTNAME');
  makeVar('POSITION');
  this._secondary = [];
  this._ports = [
    { port: this._getValue('PORT'), protocol: 'TCP', mdns: { type: '_minkebox._tcp' } },
    { port: this._getValue('PORT') + 1, protocol: 'TCP', mdns: { type: '_ssh._tcp' } }
  ];
  this._networks = {
    primary: 'none',
    secondary: 'host'
  };
  this._monitor = {};
  this._name = this._getValue('HOSTNAME');
  this._homeIP = this._getValue('IPADDRESS');
  this._defaultIP = this._homeIP;
  this._globalId = this._getValue('GLOBALID');
  this._tags = [ 'All' ];
  this._position = { tab: parseInt(this._getValue('POSITION')), widget: 0 };
}

MinkeSetup.prototype = {

  start: async function() {

    this._setTimezone();
    this._setUpdateTime();

    DNS.start({
      hostname: this._name,
      domainname: this.getLocalDomainName(),
      ip: this._getValue('IPADDRESS'),
      port: 53,
      resolvers: [ this._getValue('DNSSERVER1'), this._getValue('DNSSERVER2') ]
    });
    Human.start(this._globalId, this._vars.HUMAN);
    DDNS.start(this._globalId);
    await UPNP.start({
      uuid: this._globalId,
      hostname: this._name,
      ipaddress: this._getValue('IPADDRESS'),
      port: this._getValue('PORT')
    });
    await MDNS.start({
      ipaddress: this._getValue('IPADDRESS')
    });

    this._hostMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._getValue('IPADDRESS'),
      service: '_http._tcp',
      port: this._getValue('PORT'),
      txt: []
    });
    this._minkeMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._getValue('IPADDRESS'),
      service: '_minkebox._tcp',
      port: this._getValue('PORT'),
      txt: []
    });
    this._sshdMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._getValue('IPADDRESS'),
      service: '_ssh._tcp',
      port: this._getValue('PORT') + 1,
      txt: []
    });
  },

  stop: async function() {
    this._setStatus('shutting down');
    await MDNS.stop();
    await UPNP.stop();
    Human.stop();
    DDNS.stop();
    await DNS.stop();
  },

  updateAll: async function() {
    this._setStatus('updating');
    await Updater.updateAll();
    this._setStatus('running');
  },

  restart: async function(reason) {
    this._setStatus('restarting');
    this._bootcount = 1;
    if (this._hostMdns) {
      await MDNS.removeRecord(this._hostMdns);
    }
    this._hostMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._getValue('IPADDRESS'),
      service: '_http._tcp',
      port: this._getValue('PORT'),
      txt: []
    });
    await MDNS.removeRecord(this._minkeMdns);
    this._minkeMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._getValue('IPADDRESS'),
      service: '_minkebox._tcp',
      port: this._getValue('PORT'),
      txt: []
    });
    await MDNS.removeRecord(this._sshdMdns);
    this._sshdMdns = await MDNS.addRecord({
      hostname: this._name,
      domainname: 'local',
      ip: this._getValue('IPADDRESS'),
      service: '_ssh._tcp',
      port: this._getValue('PORT') + 1,
      txt: []
    });
    UPNP.update({ hostname: this._name });
    DNS.setHostname(this._name);
    DNS.setDefaultResolver(
      this._getValue('DNSSERVER1'),
      this._getValue('DNSSERVER2')
    );
    DNS.setDomainName(this.getLocalDomainName());
    Network.setHomeNetwork({
      enable: !this._getValue('WIFIENABLED'),
      address: this._getValue('DHCP') ? 'dhcp' : this._getValue('IPADDRESS'),
      netmask: this._getValue('NETMASK'),
      gateway: this._getValue('GATEWAY')
    });
    Network.setWiredNetwork({
      enable: !this._getValue('WIFIENABLED'),
    });
    Network.setWiFiNetwork({
      enable: this._getValue('WIFIENABLED'),
      network: this._getValue('WIFINAME'),
      password: this._getValue('WIFIPASSWORD'),
      address: this._getValue('DHCP') ? 'dhcp' : this._getValue('IPADDRESS'),
      netmask: this._getValue('NETMASK'),
      gateway: this._getValue('GATEWAY')
    });
    this._setTimezone();
    this._setUpdateTime();
    await this.save();
    Root.emit('app.status.update', { app: this, status: this._status });
    if (reason) {
      this._setStatus('restarting');
      this.systemRestart(reason);
    }
    else {
      this._setStatus('running');
    }
  },

  save: async function() {
    const config = {
      LOCALDOMAIN: null,
      IP6: null,
      NATIP6: null,
      WIFIENABLED: null,
      WIFINAME: null,
      WIFIPASSWORD: null,
      DNSSERVER1: null,
      DNSSERVER2: null,
      ADMINMODE: null,
      GLOBALID: null,
      UPDATETIME: null,
      TIMEZONE: null,
      HUMAN: null
    };
    for (let key in config) {
      config[key] = this._getValue(key);
    }
    config.HOSTNAME = this._name;
    config.POSITION = this._position.tab;
    config._id = this._id;
    await Database.saveConfig(config);
  },

  _getValue: function(key) {
    return this._vars[key].value;
  },

  setVariable: function(key, value) {
    this._vars[key].value = value;
  },

  getAvailableNetworks: function() {
    return [];
  },

  getWebLink: function() {
    return {};
  },

  _safeName: function() {
    return this._name;
  },

  _willCreateNetwork: function() {
    return false;
  },

  getAdvancedMode: function() {
    return this._getValue('ADMINMODE') === 'ENABLED';
  },

  getLocalDomainName: function() {
    return this._getValue('LOCALDOMAIN');
  },

  getIP6: function() {
    if (!Network.getSLAACAddress()) {
      return false;
    }
    else {
      return !!this._getValue('IP6');
    }
  },

  getNATIP6: function() {
    return this.getIP6() && !!this._getValue('NATIP6');
  },

  isRunning: function() {
    return true;
  },

  isStarting: function() {
    return false;
  },

  expandString: function(str) {
    return str;
  },

  getTimezone: function() {
    return this._getValue('TIMEZONE');
  },

  _setStatus: function(status) {
    const old = this._status;
    if (old !== status) {
      this._status = status;
      Root.emit('app.status.update', { app: this, status: status, oldStatus: old });
    }
    return old;
  },

  _setTimezone: function() {
    if (DEBUG) {
      return false;
    }
    try {
      const timezone = this._getValue('TIMEZONE');
      const oldtimezone = FS.readFileSync('/etc/timezone', { encoding: 'utf8' });
      const zonefile = `/usr/share/zoneinfo/${timezone}`;
      if (oldtimezone != timezone && FS.existsSync(zonefile)) {
        FS.copyFileSync(zonefile, '/etc/localtime');
        FS.writeFileSync('/etc/timezone', timezone);
        return true;
      }
    }
    catch (_) {
    }
    return false;
  },

  _setUpdateTime: function() {
    try {
      const time = this._getValue('UPDATETIME').split(':')
      const config = {
        hour: parseInt(time[0]),
        minute: parseInt(time[1])
      };
      if (config.hour >= 0 && config.hour <= 23 && config.minute >= 0 && config.minute <= 59) {
        Updater.restart(config);
      }
    }
    catch (_) {
    }
  },

  _updateIfBuiltin: async function() {
    return false;
  },

  skeletonId: function() {
    return Images.MINKE;
  },

  systemRestart: async function(reason) {
    try {
      FS.writeFileSync(RESTART_REASON, reason);
    }
    catch (_) {
    }
    switch (reason) {
      case 'restart':
      case 'update':
      case 'update-native':
        await MinkeApp.shutdown({ inherit: true });
        if (!SYSTEM) {
          // Without a system, we have to restart ourselves to apply the update. We do this by launching an
          // update helper which will wait for us to terminate and then relaunch us.
          const e = (t) => t.replace(/(\s)/g, '\\ ');
          const img = Images.withTag(Images.MINKE_UPDATER);
          await Pull.updateImage(img);
          const maps = Filesystem.getNativeMappings();
          const vols = Object.keys(maps).map(dest => `--mount type=bind,source=${e(maps[dest].src)},target=${e(dest)},bind-propagation=${maps[dest].propagation}`).join(' ');
          const net = await Network.getHomeNetwork();
          const info = await MinkeApp._container.inspect();
          const cmdline = `-d --name ${e(info.Name || 'minke')} --privileged -e TZ=${this._getValue('TIMEZONE')} --network=${e(net.id)} --ip=${this._getValue('IPADDRESS')} ${vols} ${Images.withTag(Images.MINKE)}`;
          const id = MinkeApp._container.id.substring(0, 12);
          docker.run(
            img,
            [ '/bin/sh', '-c', '/startup.sh' ],
            process.out,
            {
              Env: [ `ID=${id}`, `CMD=${cmdline}` ],
              HostConfig: {
                AutoRemove: true,
                Binds: [
                  '/var/run/docker.sock:/var/run/docker.sock'
                ]
              }
            },
            () => {}
          ).on('start', () => {
            process.exit();
          });
        }
        else {
          process.exit();
        }
        break;

      case 'restore':
        process.exit();
        break;

      case 'reboot':
      case 'halt':
      default:
        await MinkeApp.shutdown({});
        process.exit();
        break;
    }
  }

}

module.exports = MinkeSetup;
