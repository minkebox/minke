const FS = require('fs');
const Path = require('path');
const Glob = require('fast-glob');
const Images = require('../Images');

const LOCALS_DIR = `${__dirname}/local`;
const BUILTINS_DIR = `${__dirname}/builtin`;

const Builtins = {};

FS.readdirSync(BUILTINS_DIR).forEach((file) => {
  if (Path.extname(file) === '.skeleton') {
    const str = FS.readFileSync(`${BUILTINS_DIR}/${file}`, { encoding: 'utf8' });
    const skeleton = stringToSkeleton(str);
    if (skeleton) {
      Builtins[skeleton.image] = skeleton;
    }
  }
});

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
      Object.keys(info.ContainerConfig.ExposedPorts || {}).find(key => key === '67/udp') ? [
        { type: 'Feature', name: 'dhcp' }
      ] : [],
      Object.keys(info.ContainerConfig.Volumes || {}).find(key => key === '/etc/openvpn') ? [
        { type: 'Feature', name: 'vpn', defaultValue: 'network' }
      ] : [],
      // Directories
      Object.keys(info.ContainerConfig.Volumes || {}).map((key) => {
        return {
          type: 'Directory',
          name: key
        }
      }),
      // Environment - ignore some variables we don't want to include by default.
      info.ContainerConfig.Env.reduce((acc, env) => {
        const kv = env.split('=');
        switch (kv[0]) {
          case 'PATH':
          case 'LANG':
          case 'UID':
          case 'GID':
            break;
          default:
            if (kv[0].startsWith('JAVA_')) {
              break;
            }
            const e = {
              type: 'Environment',
              name: kv[0]
            };
            if (kv[1] !== '') {
              e.defaultValue = kv[1];
            }
            acc.push(e);
            break;
        }
        return acc;
      }, []),
      // Ports
      Object.keys(info.ContainerConfig.ExposedPorts || {}).map((key) => {
        return {
          type: 'Port',
          name: key,
          port: parseInt(key),
          protocol: key.split('/')[1].toUpperCase(),
          nat: false,
          web: key === '80/tcp' ? true : false,
          dns: key === '53/udp' ? true : false,
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
      polling: 0,
      parser: '',
      minwidth: '200px',
      header: '',
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
      return "`" + o.replace(/\\/g, '\\\\') + "`";
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
  catch (e) {
    console.error(e);
    console.error(str.substring(0, 200));
  }
  return skel;
}

function saveSkeleton(skeleton) {
  const path = `${LOCALS_DIR}/${skeleton.image}.skeleton`;
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, skeletonToString(skeleton));
}

function loadSkeleton(image, create) {
  let skeleton = null;
  const path = `${LOCALS_DIR}/${image}.skeleton`;
  if (FS.existsSync(path)) {
    const str = FS.readFileSync(path, { encoding: 'utf8' });
    skeleton = stringToSkeleton(str);
  }
  else {
    skeleton = Builtins[image];
    if (!skeleton && create) {
      return imageToSkeleton(image).then((skel) => {
        saveSkeleton(skel);
        return skel;
      }).catch (() => {
        return null;
      });
    }
  }
  return skeleton;
}

function catalog() {
  const cat = {};
  for (let image in Builtins) {
    if (image !== Images.MINKE) {
      cat[image] = {
        name: Builtins[image].name,
        description: Builtins[image].description,
        image: image
      };
    }
  }
  const locals = Glob.sync([ `${LOCALS_DIR}/*.skeleton`, `${LOCALS_DIR}/*/*.skeleton`, `${LOCALS_DIR}/*/*/*.skeleton` ]);
  locals.forEach((file) => {
    const str = FS.readFileSync(file, { encoding: 'utf8' });
    const skeleton = stringToSkeleton(str);
    if (skeleton) {
      cat[skeleton.image] = {
        name: skeleton.name,
        description: skeleton.description,
        image: skeleton.image
      };
    }
  });
  const list = Object.values(cat);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

module.exports = {
  imageToSkeleton: imageToSkeleton,
  saveSkeleton: saveSkeleton,
  loadSkeleton: loadSkeleton,
  toString: skeletonToString,
  parse: stringToSkeleton,
  catalog: catalog
};
