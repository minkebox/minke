const FS = require('fs');
const Path = require('path');

const Builtins = {};

FS.readdirSync(`${__dirname}/builtin/`).forEach((file) => {
  if (Path.extname(file) === '.skeleton') {
    const str = FS.readFileSync(`${__dirname}/builtin/${file}`, { encoding: 'utf8' });
    const skeleton = stringToSkeleton(str);
    if (skeleton) {
      Builtins[skeleton.image] = skeleton;
    }
  }
})

async function imageToSkeleton(image) {
  const info = await docker.getImage(image).inspect();

  return {
    name: 'MyApp',
    description: '',
    image: image,

    actions: [
    ],

    properties: [].concat(
      // Features
      Object.keys(info.ContainerConfig.ExposedPorts || {}).find(key => key === '53/udp') ? [
        { type: 'Feature', name: 'dns' }
      ] : [],
      Object.keys(info.ContainerConfig.Volumes || {}).find(key => key === '/etc/openvpn') ? [
        { type: 'Feature', name: 'vpn' }
      ] : [],
      // Directories
      Object.keys(info.ContainerConfig.Volumes || {}).map((key) => {
        return {
          type: 'Directory',
          name: key
        }
      }),
      // Ports
      Object.keys(info.ContainerConfig.ExposedPorts || {}).map((key) => {
        return {
          type: 'Port',
          name: key,
          nat: false,
          web: key === '80/tcp' ? true : false,
          mdns: null
        }
      }),
      // Networks
      {
        type: 'Network',
        name: 'primary',
        defaultValue: 'home'
      }
    ),

    monitor: {
      cmd: '',
      watch: '',
      poll: 0,
      parser: '',
      template: ''
    }
  }
}

function _tab(t) {
  let s = '';
  for (; t > 0; t--) {
    s += '  ';
  }
  return s;
}

function _toText(o, t) {
  if (Array.isArray(o)) {
    let r = "[";
    for (let i = 0; i < o.length; i++) {
      r += `${i === 0 ? '' : ','}\n${_tab(t+1)}${_toText(o[i],t+1)}`;
    }
    r += `\n${_tab(t)}]`;
    return r;
  }
  else switch (typeof o) {
    case 'string':
      return "`" + o + "`";
      break;
    case 'number':
    case 'boolean':
    case 'undefined':
      return o;
    case 'object':
      if (o === null) {
        return o;
      }
      let r = '{';
      const k = Object.keys(o);
      for (let i = 0; i < k.length; i++) {
        r += `${i === 0 ? '' : ','}\n${_tab(t+1)}${k[i]}: ${_toText(o[k[i]],t+1)}`;
      }
      r += `\n${_tab(t)}}`;
      return r;
      break;
    default:
      break;
  }
  return '';
}

function skeletonToString(skeleton) {
  return _toText(skeleton, 0);
}

function stringToSkeleton(str) {
  let skel = null;
  try {
    eval(`skel=${str}`)
  }
  catch (_) {
  }
  return skel;
}

function saveSkeleton(skeleton) {
  const path = `${__dirname}/local/${skeleton.image}.skeleton`;
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, skeletonToString(skeleton));
}

function loadSkeleton(image, create) {
  let skeleton = Builtins[image];
  if (!skeleton) {
    const path = `${__dirname}/local/${image}.skeleton`;
    if (FS.existsSync(path)) {
      const str = FS.readFileSync(path, { encoding: 'utf8' });
      skeleton = stringToSkeleton(str);
    }
    if (!skeleton && create) {
      skeleton = imageToSkeleton(image);
    }
  }
  return skeleton;
}

module.exports = {
  imageToSkeleton: imageToSkeleton,
  saveSkeleton: saveSkeleton,
  loadSkeleton: loadSkeleton,
  toString: skeletonToString,
  parse: stringToSkeleton
};
