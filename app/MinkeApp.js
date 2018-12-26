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
let koaApp = null;

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
          this._binds.push(fs.mapPrivateVolume(path));
        }
        else {
          this._binds.push(fs.mapShareableVolume(path));
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
      Hostname: this._name,
      Image: this._image, // Use the human-readable name
      HostConfig: {
        PortBindings: {},
        Mounts: this._binds.map((bind) => {
          return {
            Type: 'bind',
            Source: bind.host,
            Target: bind.target,
            BindOptions: {
              Propagation: 'rshared'
            }
          }
        }),
        PortBindings: Object.assign.apply({}, [{}].concat(this._ports.map((port) => {
          return { [port.target]: [{ HostPort: port.host }] }
        }))),
        RestartPolicy: { Name: 'on-failure' }
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
      koaApp.use(this._forward.http);
      koaApp.ws.use(this._forward.ws);
    }
    if (this._needDNS) {
      this._dns = DNSForward.createForward({ name: this._name, IP4Address: bridgeIP4Address });
    }

    return this;
  },

  stop: async function() {
    if (this._dns) {
      DNSForward.removeForward(this._dns);
    }
    if (this._forward) {
      const idx = koaApp.middleware.indexOf(this._forward.http);
      if (idx !== -1) {
        koaApp.middleware.splice(idx, 1);
      }
      const widx = koaApp.ws.middleware.indexOf(this._forward.ws);
      if (widx !== -1) {
        koaApp.ws.middleware.splice(widx, 1);
      }
    }
    if (this._ip4) {
      Network.releaseHomeIP4(this._ip4);
    }
    await this._container.stop();

    return this;
  },

  save: async function() {
    await Database.saveApp(this);
    return this;
  }

}

MinkeApp.startApps = async function(app) {

  koaApp = app;

  // Start DB
  await Database.init();

  // Find ourself
  (await docker.listContainers({})).forEach((container) => {
    if (container.Image.endsWith('/minke')) {
      container.Mounts.forEach((mount) => {
        if (mount.Type === 'bind' && mount.Destination === '/minke') {
          Filesystem.setHostPrefix(mount.Source);
        }
      })
    }
  });

  // Start all the apps
  const running = await docker.listContainers();
  const runningNames = running.reduce((accumulator, container) => {
    if (container.Config && Container.Config.Hostname) {
      accumulator.push(Container.Config.Hostname);
    }
    return accumulator;
  }, []);
  const apps = await Database.getApps();
  await Promise.all(apps.map(async (info) => {
    const app = new MinkeApp().createFromJSON(info);
    // Stop if running
    const idx = runningNames.indexOf(app._name);
    if (idx !== -1) {
      await running[idx].stop();
    }
    await app.start();
  }));
}

MinkeApp.shutdown = async function() {
  return Promise.all(Object.values(applications).map(async (app) => {
    return app.stop();
  }));
}

module.exports = MinkeApp;
