const FS = require('fs');
const Path = require('path');
const Glob = require('fast-glob');
const VM = require('vm');
const Tar = require('tar-stream');

const LOCALS_DIR   = `${__dirname}/local`;
const BUILTINS_DIR = `${__dirname}/builtin`;
const INTERNAL_DIR = `${__dirname}/internal`;

const Builtins = {};

function selectImage(skeleton) {
  if (skeleton.images && (process.arch in skeleton.images)) {
    skeleton.image = skeleton.images[process.arch];
  }
  if (skeleton.secondary) {
    skeleton.secondary.forEach(second => {
      if (second.images && (process.arch in second.images)) {
        second.image = second.images[process.arch];
      }
    });
  }
  return (skeleton.secondary || []).reduce((r, second) => {
    return r && second.image;
  }, skeleton.image);
}

FS.readdirSync(BUILTINS_DIR).forEach((file) => {
  if (Path.extname(file) === '.skeleton') {
    const str = FS.readFileSync(`${BUILTINS_DIR}/${file}`, { encoding: 'utf8' });
    const skeleton = stringToSkeleton(str);
    if (skeleton) {
      Builtins[skeleton.image] = skeleton;
    }
  }
});

async function findImageInternalSkeleton(image) {
  const container = await docker.createContainer({
    Image: image
  });
  try {
    const tarstream = await container.getArchive({
      path: `/minkebox/skeleton`,
    });
    const extract = Tar.extract();
    return new Promise(resolve => {
      let content = '';
      extract.on('entry', (header, stream, next) => {
        if (header.name === 'skeleton') {
          stream.on('data', data => {
            content += data.toString();
          });
        }
        stream.on('end', () => {
          next();
        });
        stream.resume();
      });
      extract.on('finish', () => {
        if (content) {
          resolve(stringToSkeleton(content));
        }
        else {
          resolve(null);
        }
      });
      tarstream.pipe(extract);
    });
  }
  catch (_) {
    return null;
  }
  finally {
    container.remove({ force: true });
  }
}

async function imageToSkeleton(image) {
  const info = await docker.getImage(image).inspect();

  return {
    name: 'MyApp',
    description: '',
    image: image,
    tags: [ 'App' ],

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
        { type: 'Feature', name: 'vpn' }
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
  // Clone and remove any properties we shouldn't see in the text version of a skeleton
  const skel = JSON.parse(JSON.stringify(skeleton));
  if (skel.images) {
    delete skel.image;
  }
  (skel.secondary || []).forEach(secondary => {
    if (secondary.images) {
      delete secondary.image;
    }
  });
  return _toText(skel, 0);
}

function stringToSkeleton(str) {
  let skel;
  try {
    const sandbox = { skel: null, err: null };
    // NOTE: Last time I checked, runInNewContext had a small memory leak. This is
    // called infrequently enough that we don't expect it to be a problem here.
    VM.runInNewContext('(function(){try{skel=' + str + '}catch(e){err=e}})()', sandbox);
    if (sandbox.err) {
      throw sandbox.err;
    }
    skel = sandbox.skel;
    if (skel == undefined || skel === null || typeof skel !== 'object' || Array.isArray(skel)) {
      throw new Error('Bad root');
    }
    // Try to keep bad properties out of the skeleton
    function obj(o) {
      switch (typeof o) {
        case 'undefined':
        case 'boolean':
        case 'string':
        case 'number':
          return true;
        case 'object':
          if (o === null) {
            return true;
          }
          if (Array.isArray(o)) {
            for (let i = 0; i < o.length; i++) {
              if (!obj(o[i])) {
                return false;
              }
            }
            return true;
          }
          for (let k in o) {
            if (!obj(o[k])) {
              return false;
            }
          }
          return true;
        default:
          break;
      }
      return false;
    }
    if (!obj(skel)) {
      throw new Error('Bad skeleton');
    }
    if (typeof skel.name !== 'string') {
      throw new Error('Missing name');
    }
    if (!Array.isArray(skel.properties)) {
      throw new Error('Missing properties');
    }
    if (!selectImage(skel)) {
      // No image for this architecture
      skel = null;
    }
    else if (typeof skel.image !== 'string') {
      throw new Error('Missing image');
    }
  }
  catch (e) {
    console.error(e);
    console.error(str.substring(0, 200));
    return null;
  }
  return skel;
}

function saveLocalSkeleton(skeleton) {
  const path = `${LOCALS_DIR}/${skeleton.image}.skeleton`;
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, skeletonToString(skeleton));
}

function saveInternalSkeleton(skeleton) {
  const path = `${INTERNAL_DIR}/${skeleton.image}.skeleton`;
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(path, skeletonToString(skeleton));
}

function loadSkeleton(image, create) {
  const lpath = `${LOCALS_DIR}/${image}.skeleton`;
  if (FS.existsSync(lpath)) {
    return {
      type: 'local',
      skeleton: stringToSkeleton(FS.readFileSync(lpath, { encoding: 'utf8' }))
    };
  }
  const ipath = `${INTERNAL_DIR}/${image}.skeleton`;
  if (FS.existsSync(ipath)) {
    return {
      type: 'internal',
      skeleton: stringToSkeleton(FS.readFileSync(ipath, { encoding: 'utf8' }))
    };
  }
  if (image in Builtins) {
    return {
      type: 'builtin',
      skeleton: Builtins[image]
    };
  }
  if (!create) {
    return null;
  }
  return findImageInternalSkeleton(image).then((skel) => {
    if (skel) {
      saveInternalSkeleton(skel);
      return {
        type: 'internal',
        skeleton: skel
      };
    }
    else {
      return imageToSkeleton(image).then((skel) => {
        saveLocalSkeleton(skel);
        return {
          type: 'local',
          skeleton: skel
        };
      });
    }
  }).catch ((e) => {
    console.log(e);
    return null;
  });
}

async function updateInternalSkeleton(image) {
  const skel = await findImageInternalSkeleton(image);
  if (skel) {
    await saveInternalSkeleton(skel);
  }
  return skel;
}

function catalog() {
  const cat = {};

  // Builtins first
  for (let image in Builtins) {
    if (Builtins[image].catalog !== false) {
      cat[image] = {
        name: Builtins[image].name,
        description: Builtins[image].description,
        tags: Builtins[image].tags || [],
        image: image
      };
    }
  }

  // Internals override builtins
  const internal = Glob.sync([
    `${INTERNAL_DIR}/*.skeleton`, `${INTERNAL_DIR}/*/*.skeleton`, `${INTERNAL_DIR}/*/*/*.skeleton`
  ]);
  internal.forEach((file) => {
    const skeleton = stringToSkeleton(FS.readFileSync(file, { encoding: 'utf8' }));
    if (skeleton && skeleton.catalog !== false) {
      cat[skeleton.image] = {
        name: skeleton.name,
        description: skeleton.description,
        tags: skeleton.tags || [],
        image: skeleton.image
      };
    }
  });

  // Locals override everything
  const locals = Glob.sync([
    `${LOCALS_DIR}/*.skeleton`, `${LOCALS_DIR}/*/*.skeleton`, `${LOCALS_DIR}/*/*/*.skeleton`
  ]);
  locals.forEach((file) => {
    const skeleton = stringToSkeleton(FS.readFileSync(file, { encoding: 'utf8' }));
    if (skeleton && skeleton.catalog !== false) {
      cat[skeleton.image] = {
        name: skeleton.name,
        description: skeleton.description,
        tags: skeleton.tags || [],
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
  saveLocalSkeleton: saveLocalSkeleton,
  loadSkeleton: loadSkeleton,
  updateInternalSkeleton: updateInternalSkeleton,
  toString: skeletonToString,
  parse: stringToSkeleton,
  catalog: catalog
};
