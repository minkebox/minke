const HTTPForward = require('./HTTPForward');
const DNSForward = require('./DNSForward');
const Network = require('./Network');

const TCP_HTTP = '80/tcp';
const TCP_DNS = '53/udp';
const UDP_DNS = '53/udp';

const applications = {};


async function _MinkeApp(args) {
  this._name = args.name;
  this._imageName = args.image;
  this._type = args.type;
  this._forwarder = null;
  this._macAddress = null;
  this._ip4Address = null;
  this._image = await docker.getImage(args.image);
  this._imageInfo = await this._image.inspect();
  this._env = args.env || [];

  const config = this._imageInfo.ContainerConfig;
  config.Image = args.image; // Use the human-readable name
  config.Labels.MinkeName = this._name;
  console.log('image', config);

  switch (this._type) {
    case 'map':
      config.HostConfig = { PortBindings: {} };
      for (let port in config.ExposedPorts) {
        config.HostConfig.PortBindings[port] = [{
          HostPort: `${parseInt(port)}`
        }];
      }
      break;

    case 'host':
    console.log('host');
      const hostnet = await Network.getHostNetwork();
    console.log(hostnet);
      this._macAddress = Network.generateMacAddress(`${this._name}/${this._imageName}`);
    console.log(this._macAddress);
      this._ip4Address = await Network.getHomeIP4Address(this._macAddress);
    console.log(this._ip4Address);
      config.NetworkingConfig = {
        EndpointsConfig: {
          [hostnet.id]: {
            IPAMConfig: {
              IPv4Address: this._ip4Address
            },
          }
        }
      };
      config.MacAddress = this._macAddress;
      config.HostConfig = {
        NetworkMode: hostnet.id
      }
      this._env.push(`MINKE_HOME_IP4ADDRESS=${this._ip4Address}`);
      break;

    case 'hidden':
    default:
      break;
  }

  config.Env = config.Env.concat(this._env);
  this._container = await docker.createContainer(config);
  console.log('container', this._container);

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

  await this._container.start();
  this._containerInfo = await this._container.inspect();
  console.log('containerInfo', this._containerInfo);
  
  const bridgeIP4Address = this._containerInfo.NetworkSettings.Networks.bridge.IPAddress;
  if (config.ExposedPorts[TCP_HTTP]) {
    this._http = HTTPForward.createForward({ prefix: `/a/${this._name}`, IP4Address: bridgeIP4Address, port: parseInt(TCP_HTTP) });
    _MinkeApp._app.use(this._http);
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
    if (app._http) {
      const idx = _MinkeApp._app.middleware.indexOf(app._http);
      if (idx !== -1) {
        _MinkeApp._app.middleware.splice(idx, 1);
      }
    }
    if (app._ip4Address) {
      Network.releaseHomeIPAddress(app._ip4Address);
    }
    await app._container.kill();
  }
}

module.exports = MinkeApp;
