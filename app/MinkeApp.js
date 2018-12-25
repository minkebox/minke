const HTTPForward = require('./HTTPForward');
const DNSForward = require('./DNSForward');
const Network = require('./Network');
const Filesystem = require('./Filesystem');
const Database = require('./Database');

const DEBUG = !!process.env.DEBUG;

const TCP_HTTP = '80/tcp';
const TCP_DNS = '53/udp';
const UDP_DNS = '53/udp';

const applications = {};

function MinkeApp() {
}

MinkeApp.prototype = {

  createFromConfig: async function(config) {
    
    this._name = config.name;
    this._image = config.image;
    this._env = config.env || [];

    const image = await docker.getImage(this._image);
    const imageInfo = await image.inspect();
    const containerConfig = imageInfo.ContainerConfig;

    if (config.type === 'map') {
      this._ports = Object.keys(containerConfig.ExposedPorts).map((port) => {
        return {
          style: 'portmap',
          name: `${this._name}:${port}`,
          target: port,
          host: parseInt(port)
        }
      });
    }
    else {
      this._ports = [];
    }

    this._binds = [];
    if (containerConfig.Volumes || config.fsmap) {
      const fsmap = config.fsmap || {};
      const fs = Filesystem.createAppFS(this);
      const volumes = Object.assign({}, containerConfig.Volumes, config.fsmap);
      for (let path in volumes) {
        const map = fsmap[path];
        if (!map || map.type === 'private') {
          const binding = fs.mapPrivateVolume(path).split(':');
          this._binds.push({
            name: `${this._name}:${binding[1]}`,
            shareable: false,
            host: binding[0],
            target: binding[1]
          });
        }
        else {
          const binding = fs.mapShareableVolume(path).split(':');
          this._binds.push({
            name: `${this._name}:${binding[1]}`,
            shareable: true,
            host: binding[0],
            target: binding[1]
          });
        }
      }
    }

    if (config.type === 'host') {
      this._ip4 = {}; // IP4 will be created when app is started
    }
    else {
      this._ip4 = null;
    }
    this._needLink = !!containerConfig.ExposedPorts[TCP_HTTP];
    this._needDNS = !!(containerConfig.ExposedPorts[TCP_DNS] && containerConfig.ExposedPorts[UDP_DNS]);

    return this;
  },

  createFromJSON: function(app) {

    this._name = app.name;
    this._image = app.image;
    this._env = app.env;
    this._ports = app.ports;
    this._binds = app.binds;
    this._ip4 = app.ip4;
    this._needLink = app.link;
    this._needDNS = app.dns;

    return this;
  },

  toJSON: function() {
    return {
      name: this._name,
      image: this._image,
      env: this._env,
      link: this._needLink,
      dns: this._needDNS,
      ip4: this._ip4,
      ports: this._ports,
      binds: this._binds
    }
  },

  start: async function() {
  
    const config = {
      Image: this._image, // Use the human-readable name
      HostConfig: {
        PortBindings: {},
        Binds: this._binds.map((bind) => {
          return `${bind.host}:${bind.target}`;
        }),
        PortBindings: Object.assign.apply({}, [{}].concat(this._ports.map((port) => {
          return { [port.target]: [{ HostPort: port.host }] }
        }))),
        RestartPolicy: { Name: 'unless-stopped' }
      },
      Env: this._env
    };

    // Primary network is the host network, not the bridge
    if (this._ip4) {
      const hostnet = await Network.getHostNetwork();
      this._ip4 = await Network.getHomeIP4(`${this._name}/${this._image}`, this._ip4);
      config.NetworkingConfig = {
        EndpointsConfig: {
          [hostnet.id]: {
            IPAMConfig: {
              IPv4Address: this._ip4.address
            }
          }
        }
      };
      config.MacAddress = this._ip4.mac;
      config.HostConfig.NetworkMode = hostnet.id;
    }

    if (DEBUG) {
      config.HostConfig.AutoRemove = true;
      config.StopTimeout = 1;
      delete config.HostConfig.RestartPolicy;
    }
  
    this._container = await docker.createContainer(config);
    await this._container.start();
    applications[this._name] = this;

    // If we're connected to the host network, we also need a bridge network. We have to add it after
    // the container is started otherwise it becomes eth0 (which we don't want).
    if (this._ip4) {
      const bridge = await Network.getBridgeNetwork();
      await bridge.connect({
        Container: this._container.id
      });
    }

    const containerInfo = await this._container.inspect();

    const bridgeIP4Address = containerInfo.NetworkSettings.Networks.bridge.IPAddress;
    if (this._needLink) {
      this._forward = HTTPForward.createForward({ prefix: `/a/${this._name}`, IP4Address: bridgeIP4Address, port: parseInt(TCP_HTTP) });
      MinkeApp._app.use(this._forward.http);
      MinkeApp._app.ws.use(this._forward.ws);
    }
    if (this._needDNS) {
      this._dns = DNSForward.createForward({ name: this._name, IP4Address: bridgeIP4Address });
    }

    return this;
  },

  save: async function() {
    await Database.saveApp(this);
    return this;
  }

}

MinkeApp.startApps = async function(app) {

  MinkeApp._app = app;

  // Start DB
  await Database.init();

  // Find ourself
  const containers = await docker.listContainers({});
  containers.forEach((container) => {
    if (container.Image.endsWith('/minke')) {
      MinkeApp._container = container;
      container.Mounts.forEach((mount) => {
        if (mount.Type === 'bind' && mount.Destination === '/minke') {
          Filesystem.setHostPrefix(mount.Source);
        }
      })
    }
  });

  // Start all the apps
  await Promise.all((await Database.getApps()).map(async (info) => {
    await new MinkeApp().createFromJSON(info).start();
  }));
}

MinkeApp.shutdown = async function() {
  for (let name in applications) {
    const app = applications[name];
    if (app._dns) {
      DNSForward.removeForward(app._dns);
    }
    if (app._forward) {
      const idx = MinkeApp._app.middleware.indexOf(app._forward.http);
      if (idx !== -1) {
        MinkeApp._app.middleware.splice(idx, 1);
      }
      const widx = MinkeApp._app.ws.middleware.indexOf(app._forward.ws);
      if (widx !== -1) {
        MinkeApp._app.ws.middleware.splice(widx, 1);
      }
    }
    if (app._ip4) {
      Network.releaseHomeIP4(app._ip4);
    }
    await app._container.stop();
  }
}

module.exports = MinkeApp;
