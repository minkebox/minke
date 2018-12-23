const HTTPForward = require('./HTTPForward');
const DNSForward = require('./DNSForward');
const Network = require('./Network');
const Filesystem = require('./Filesystem');

const TCP_HTTP = '80/tcp';
const TCP_DNS = '53/udp';
const UDP_DNS = '53/udp';

const applications = {};


async function _MinkeApp(args) {
  this._name = args.name;
  this._imageName = args.image;
  this._type = args.type;
  this._fsmap = args.fsmap;
  this._forwarder = null;
  this._macAddress = null;
  this._ip4Address = null;
  this._image = await docker.getImage(args.image);
  this._imageInfo = await this._image.inspect();
  this._env = args.env || [];

  const config = this._imageInfo.ContainerConfig;
  config.Image = args.image; // Use the human-readable name
  config.Labels.MinkeName = this._name;
  config.HostConfig = { PortBindings: {}, Binds: [] };

  switch (this._type) {
    case 'map':
      for (let port in config.ExposedPorts) {
        config.HostConfig.PortBindings[port] = [{
          HostPort: `${parseInt(port)}`
        }];
      }
      const iface = await Network.getActiveInterface();
      this._env.push(`MINKE_HOME_IP4_ADDRESS=${iface.network.ip_address}`, `MINKE_HOME_IP4_GATEWAY=${iface.network.gateway_ip}`);
      break;

    case 'host':
      const hostnet = await Network.getHostNetwork();
      this._ip4 = await Network.getHomeIP4(`${this._name}/${this._imageName}`);
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
      config.HostConfig = {
        NetworkMode: hostnet.id
      }
      this._env.push(`MINKE_HOME_IP4_ADDRESS=${this._ip4.address}`, `MINKE_HOME_IP4_GATEWAY=${this._ip4.gateway}`);
      break;

    case 'hidden':
      this._env.push(`MINKE_HOME_IP4_ADDRESS=__HIDDEN__`, `MINKE_HOME_IP4_GATEWAY=__HIDDEN__`);
      break;

    default:
      break;
  }

  if (config.Volumes || this._fsmap) {
    const fsmap = this._fsmap || {};
    this._fs = Filesystem.createAppFS(this);
    const volumes = Object.assign({}, config.Volume, this._fsmap);
    for (let path in volumes) {
      const map = fsmap[path];
      if (!map || map.type === 'private') {
        config.HostConfig.Binds.push(this._fs.mapPrivateVolume(path));
      }
      else {
        config.HostConfig.Binds.push(this._fs.mapSharedVolume(path));
      }
    }
  }

  config.Env = config.Env.concat(this._env);
  this._container = await docker.createContainer(config);
  await this._container.start();

  switch (this._type) {
    case 'host':
      const bridge = await Network.getBridgeNetwork();
      await bridge.connect({
        Container: this._container.id
      });
      break;

    case 'map':
    case 'hidden':
    default:
      break;
  }

  this._containerInfo = await this._container.inspect();
  
  const bridgeIP4Address = this._containerInfo.NetworkSettings.Networks.bridge.IPAddress;
  if (config.ExposedPorts[TCP_HTTP]) {
    this._forward = HTTPForward.createForward({ prefix: `/a/${this._name}`, IP4Address: bridgeIP4Address, port: parseInt(TCP_HTTP) });
    _MinkeApp._app.use(this._forward.http);
    _MinkeApp._app.ws.use(this._forward.ws);
  }
  if (config.ExposedPorts[TCP_DNS] && config.ExposedPorts[UDP_DNS]) {
    this._dns = DNSForward.createForward({ name: this._name, IP4Address: bridgeIP4Address });
  }

  applications[this._name] = this;
}

_MinkeAppPrototype = {
}

const MinkeApp = async function(args) {
  const self = Object.assign({}, _MinkeAppPrototype);
  await _MinkeApp.call(self, args);
  return self;
}

MinkeApp.setApp = function(app) {
  _MinkeApp._app = app;
}

MinkeApp.shutdown = async function() {
  for (let name in applications) {
    const app = applications[name];
    if (app._dns) {
      DNSForward.removeForward(app._dns);
    }
    if (app._forward) {
      const idx = _MinkeApp._app.middleware.indexOf(app._forward.http);
      if (idx !== -1) {
        _MinkeApp._app.middleware.splice(idx, 1);
      }
      const widx = _MinkeApp._app.ws.middleware.indexOf(app._forward.ws);
      if (widx !== -1) {
        _MinkeApp._app.ws.middleware.splice(widx, 1);
      }
    }
    if (app._ip4Address) {
      Network.releaseHomeIPAddress(app._ip4Address);
    }
    await app._container.kill();
  }
}

module.exports = MinkeApp;
