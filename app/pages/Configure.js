const FS = require('fs');
const Path = require('path');
const Handlebars = require('./HB');
const MinkeApp = require('../MinkeApp');
const Images = require('../Images');
const Skeletons = require('../Skeletons');
const Network = require('../Network');
const Disks = require('../Disks');
const Human = require('../Human');
const ConfigBackup = require('../ConfigBackup');
const UPNP = require('../UPNP');
const Filesystem = require('../Filesystem');

const MinkeBoxConfiguration = 'minke'; // MinkeSetup._id

let template;
let downloadTemplate;
let websitesTemplate;
function registerTemplates() {
  const partials = [
    'EditTable',
    'ShowTable',
    'SelectDirectory',
    'SelectShares',
    'EditShares',
    'SelectWebsites',
    'Disks',
    'BackupAndRestore',
    'DownloadFile',
    'SelectBackups'
  ];
  partials.forEach((partial) => {
    Handlebars.registerPartial(partial, Handlebars.compile(
      FS.readFileSync(`${__dirname}/html/partials/${partial}.html`, { encoding: 'utf8' }), { preventIndent: true }));
  });
  template = Handlebars.compile(FS.readFileSync(`${__dirname}/html/Configure.html`, { encoding: 'utf8' }), { preventIndent: true });
  downloadTemplate = Handlebars.compile('{{> DownloadFile}}', { preventIndent: true });
  websitesTemplate = Handlebars.compile('{{> SelectWebsites}}', { preventIndent: true });
}
if (!DEBUG) {
  registerTemplates();
}

async function ConfigurePageHTML(ctx) {

  if (DEBUG) {
    registerTemplates();
  }

  const app = MinkeApp.getAppById(ctx.params.id);
  if (!app) {
    throw new Error(`Missing app: ${ctx.params.id}`);
  }
  const skel = await Skeletons.loadSkeleton(app._image, true);
  if (!skel) {
    throw new Error(`Failed to load skeleton: ${app._image}`);
  }
  const skeleton = skel.skeleton;
  const minkeConfig = app._image == Images.MINKE;

  async function expand(text) {
    return await app.expand(text);
  }

  let nextid = 100;
  const firstUse = (app._bootcount === 0);
  const visibles = {};
  const enabled = {};
  const properties = {
    Advanced: MinkeApp.getAdvancedMode(),
    FirstUse: firstUse,
    WifiAvailable: minkeConfig && SYSTEM ? (await Network.wifiAvailable()) : false,
    UPnPAvailable: UPNP.available(),
    NoSystemControl: !SYSTEM
  };
  let help = false;
  const navbuttons = [];
  const nskeleton = {
    name: skeleton.name,
    value: app._name,
    description: await expand(skeleton.description),
    actions: await Promise.all(skeleton.actions.map(async action => {
      if ('visible' in action || 'enabled' in action) {
        const id = action.id || `x${++nextid}`;
        if ('visible' in action) {
          visibles[id] = action.visible;
          action = Object.assign({ id: id }, action);
        }
        if ('enabled' in action) {
          enabled[id] = action.enabled;
          action = Object.assign({ id: id }, action);
        }
      }
      switch (action.type) {
        case 'Text':
          {
            return Object.assign({}, action, { text: await expand(action.text) });
          }
        case 'Help':
          {
            help = true;
            return Object.assign({}, action, { text: await expand(action.text) });
          }
        case 'NavButton':
          {
            navbuttons.push({
              name: action.name,
              link: await expand(action.url),
              linktarget: '_blank'
            });
            return action;
          }
        case 'EditEnvironment':
          {
            let value = '';
            const env = app._env[action.name];
            if (env) {
              value = env.value;
            }
            if (!value && firstUse && action.initValue) {
              value = await expand(action.initValue);
              app._env[action.name] = { value: value };
            }
            properties[`${action.type}#${action.name}`] = value;
            const placeholder = await expand((skeleton.properties.find(prop => prop.type === 'Environment' && prop.name === action.name) || {}).defaultValue);
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, value: value, placeholder: placeholder, options: action.options }, action, { description: await expand(action.description) });
          }
        case 'EditEnvironmentAsCheckbox':
          {
            let value = '';
            const env = app._env[action.name];
            if (env) {
              value = env.value;
            }
            if (!value && firstUse && action.initValue) {
              value = await expand(action.initValue);
              app._env[action.name] = { value: value };
            }
            properties[`${action.type}#${action.name}`] = value;
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.checked)`, value: value }, action, { description: await expand(action.description) });
          }
        case 'EditEnvironmentAsTable':
          {
            let value = '';
            const env = app._env[action.name];
            if (env) {
              value = env.value;
            }
            if (!value && firstUse && action.initValue) {
              value = await expand(action.initValue);
              app._env[action.name] = { value: value };
              const altValue = action.initAltValue;
              if (altValue) {
                app._env[action.name].altValue = await expand(altValue);
              }
            }
            properties[`${action.type}#${action.name}`] = value;
            let avalue = [];
            if (env && env.altValue) {
              try {
                avalue = JSON.parse(env.altValue);
                const hlen = action.headers.length;
                avalue.forEach(v => {
                  while (v.length < hlen) {
                    v.push('');
                  }
                });
              }
              catch (_) {
              }
            }
            return Object.assign({ action: `${action.type}#${action.name}`, value: avalue, controls: true }, action, { description: await expand(action.description) });
          }
        case 'SelectWebsites':
          {
            const env = app._env[action.name];
            properties[`${action.type}#${action.name}`] = env ? env.value : '';
            let currentSites = [];
            if (env && env.altValue) {
              try {
                currentSites = JSON.parse(env.altValue);
              }
              catch (_) {
              }
            }
            const websites = (await app.getAvailableWebsites(app._networks.primary)).map((site) => {
              const match = currentSites.find(cs => cs[0] === site.app._id);
              return {
                appid: site.app._id,
                name: site.app._name,
                hostname: site.app._safeName(),
                port: site.port.port,
                dns: match ? match[3] : '',
                published: match ? !!match[4] : false
              };
            });
            return Object.assign({ action: `${action.type}#${action.name}`, websites: websites }, action, { description: await expand(action.description) });
          }
        case 'SelectNetwork':
          {
            const networks = [{ _id: 'none', name: 'none' }].concat(app.getAvailableNetworks());
            const network = app._networks[action.name] || 'none';
            properties[`${action.type}#${action.name}`] = network;
            // If we chance the primary network then the websites we can select will also change.
            let reload = '';
            if (action.name === 'primary' && skeleton.actions.find(action => action.type === 'SelectWebsites')) {
              reload = `;window.cmd('app.update-websites',this.value)`;
            }
            return Object.assign({
              action: `window.action('${action.type}#${action.name}',this.value)` + reload,
              networks: networks,
              value: network
            }, action, { description: await expand(action.description) });
          }
        case 'ShowFileAsTable':
          {
            const file = app._files.find(file => file.target === action.name);
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            let value = [];
            try {
              value = JSON.parse(file.data)
            }
            catch (_) {
            }
            return Object.assign({ value: value }, action, { description: await expand(action.description) });
          }
        case 'ShowFile':
          {
            const file = app._files.find(file => file.target === action.name);
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            return Object.assign({ value: file ? file.data : '' }, action, { description: await expand(action.description) });
          }
        case 'DownloadFile':
          {
            const file = app._files.find(file => file.target === action.name);
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            const value = file ? file.data : '';
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, value: value, filename: Path.basename(action.name) }, action, { description: await expand(action.description) });
          }
        case 'EditFile':
          {
            const file = app._files.find(file => file.target === action.name);
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            const value = file ? file.data : '';
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, value: value, filename: Path.basename(action.name) }, action, { description: await expand(action.description) });
          }
        case 'EditFileAsTable':
          {
            let value = null;
            const file = app._files.find(file => file.target === action.name);
            if (file && file.altData) {
              try {
                value = JSON.parse(file.altData);
              }
              catch (_) {
              }
            }
            else if (firstUse && action.initValue) {
              try {
                value = JSON.parse(await expand(action.initValue));
              }
              catch (_) {
              }
            }
            if (value) {
              try {
                value = JSON.parse(file.altData);
                const hlen = action.headers.length;
                value.forEach((v) => {
                  while (v.length < hlen) {
                    v.push('');
                  }
                });
              }
              catch (_) {
              }
            }
            else {
              value = [];
            }
            return Object.assign({ action: `${action.type}#${action.name}`, value: value, controls: true }, action, { description: await expand(action.description) });
          }
        case 'SelectDirectory':
          {
            const allShares = app.getAvailableShareables();
            allShares.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);
            let found = false;
            const shareables = await Promise.all(allShares.map(async shareable => {
              const shares = [];
              await Promise.all(shareable.shares.map(async bind => {
                await Promise.all(bind.shares.map(async share => {
                  const target = Path.normalize(`${shareable.app._name}/${bind.target}/${share.name}/`).slice(0, -1).replace(/\//g, '.');
                  const src = Path.normalize(`${bind.src}/${share.name}/`).slice(0, -1);
                  const selected = !!app._binds.find(abind => abind.src === src);
                  found |= selected;
                  shares.push({
                    name: target,
                    src: src,
                    description: await expand(share.description),
                    value: selected
                  });
                }));
                return shares;
              }));
              return {
                app: shareable.app,
                shares: shares
              };
            }));
            const nativedirs = Filesystem.getNativeDirectories();
            if (nativedirs.length) {
              shareables.push({
                app: {
                  _id: 'native',
                  _name: 'Native'
                },
                shares: nativedirs.map(dir => {
                  const selected = !!app._binds.find(abind => abind.src === dir.src);
                  found |= selected;
                  return { name: Path.basename(dir.src), src: dir.src, description: dir.src, value: selected }
                })
              });
            }
            const prop = skeleton.properties.find(prop => prop.name === action.name);
            if (prop) {
              shareables.unshift({
                app: app, shares: [{ name: 'Local', src: Filesystem.getNativePath(app._id, prop.style, `/dir/${action.name}`), description: 'Local', value: !found }]
              });
            }
            return Object.assign({ action: `window.action('${action.type}#${action.name}',event.target.value)`, shareables: shareables }, action, { description: await expand(action.description) });
          }
        case 'EditShares':
          {
            const bind = app._binds.find(bind => bind.target === action.name) || { shares: [] };
            return Object.assign({
              action: `${action.type}#${action.name}`, shareables: bind.shares.map(share => {
                let empty = true;
                try {
                  empty = FS.readdirSync(`${bind.src}/${share.name}`).length === 0;
                }
                catch (_) {
                }
                return {
                  name: share.name,
                  empty: empty
                };
              })
            }, action, { description: await expand(action.description) });
          }
        case 'SelectShares':
          {
            const binding = app._binds.find(bind => bind.target === action.name) || { shares: [] };
            const allShares = app.getAvailableShareables();
            allShares.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);
            const shareables = await Promise.all(allShares.map(async shareable => {
              const shares = [];
              await Promise.all(shareable.shares.map(async bind => {
                await Promise.all(bind.shares.map(async share => {
                  const defaultName = Path.normalize(`${shareable.app._name}/${bind.target}/${share.name}/`).slice(0, -1).replace(/\//g, '.');
                  const src = Path.normalize(`${bind.src}/${share.name}/`).slice(0, -1);
                  const ashare = binding.shares.find(ashare => ashare.src === src);
                  const altName = ashare ? ashare.name : '';
                  shares.push({
                    name: defaultName,
                    altname: altName != defaultName ? altName : null,
                    description: await expand(share.description),
                    action: `window.share('${action.type}#${shareable.app._id}#${src}#${action.name}#${defaultName}',this)`,
                    value: !!ashare
                  });
                }));
              }));
              return {
                app: shareable.app,
                shares: shares
              };
            }));
            const nativedirs = Filesystem.getNativeDirectories();
            if (nativedirs.length) {
              shareables.push({
                app: { _id: 'native', _name: 'Native' },
                shares: nativedirs.map(dir => {
                  const defaultName = Path.basename(dir.src);
                  const ashare = binding.shares.find(ashare => ashare.src === dir.src);
                  return {
                    name: defaultName,
                    altname: ashare ? ashare.name : '',
                    description: dir.src,
                    action: `window.share('${action.type}#native#${dir.src}#${action.name}#${defaultName}',this)`,
                    value: !!ashare
                  }
                })
              });
            }
            return Object.assign({ shareables: shareables }, action, { description: await expand(action.description) });
          }
        case 'SelectBackups':
          {
            const allBackups = app.getAvailableBackups();
            allBackups.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);
            const backups = allBackups.map(backup => {
              return {
                id: backup.app._id,
                name: backup.app._name,
                action: `window.backup('${action.type}#${backup.app._id}#${action.name}',this)`,
                value: !!app._backups.find(abk => abk.appid === backup.app._id)
              };
            });
            const midx = backups.findIndex(backup => backup.id === MinkeBoxConfiguration);
            if (midx !== -1) {
              const config = backups.splice(midx, 1)[0];
              config.name = `${config.name} (Configuration)`;
              backups.unshift(config);
            }
            return Object.assign({ backups: backups }, action, { description: await expand(action.description) });
          }
        case '__Disks':
          {
            if (!minkeConfig) {
              return {};
            }
            const diskinfo = Object.values((await Disks.getAllDisks()).diskinfo);
            const havestore = diskinfo.find(info => info.root === '/mnt/store');
            return {
              type: '__Disks',
              disks: diskinfo.map(disk => {
                return {
                  name: disk.root === '/minke' ? 'boot' : disk.root === '/mnt/store' ? 'store' : disk.name,
                  size: (disk.size / (1000 * 1000 * 1000)).toFixed(2) + 'GB',
                  percentage: disk.size === 0 ? 0 : (disk.used / disk.size * 100).toFixed(1),
                  tenth: parseInt(disk.size === 0 ? 0 : (disk.used / disk.size * 10)),
                  status: disk.status,
                  format: SYSTEM && !havestore && disk.root !== '/minke'
                }
              })
            };
          }
        case '__Captcha':
          {
            if (!minkeConfig) {
              return {};
            }
            const valid = Human.isVerified();
            return {
              type: '__Captcha',
              label: valid ? 'Verified' : 'Unverified: Click to verify',
              enabled: !valid
            };
          }
        case 'Header':
        case 'Script':
        case 'Argument':
        default:
          return action;
      }
    }))
  }
  const advanced = MinkeApp.getAdvancedMode();
  ctx.body = template({
    minkeConfig: minkeConfig,
    Advanced: advanced,
    skeleton: nskeleton,
    skeletonType: advanced && !minkeConfig ? skel.type : null,
    properties: JSON.stringify(properties),
    skeletonAsText: Skeletons.toString(skeleton),
    navbuttons: navbuttons,
    firstUse: properties.FirstUse,
    NoSystemControl: properties.NoSystemControl,
    help: help,
    changes: '[' + Object.keys(visibles).map((key) => {
      return `function(){try{const c=document.getElementById("${key}").classList;if(${visibles[key]}){c.remove("invisible")}else{c.add("invisible")}}catch(_){}}`;
    }).concat(Object.keys(enabled).map((key) => {
      return `function(){try{const v=(${enabled[key]});document.querySelectorAll("#${key}.can-disable,#${key} .can-disable").forEach((e)=>{e.disabled=(v?'':'disabled');if(v){e.classList.remove("disabled")}else{e.classList.add("disabled")}})}catch(_){}}`
    })).join(',') + ']'
  });
  ctx.type = 'text/html'
}

async function ConfigurePageWS(ctx) {

  function send(msg) {
    try {
      ctx.websocket.send(JSON.stringify(msg));
    }
    catch (_) {
    }
  }

  let app = MinkeApp.getAppById(ctx.params.id);
  const skeleton = Skeletons.loadSkeleton(app._image, false).skeleton;

  const NOCHANGE = 0;
  const APPCHANGE = 1;
  const SKELCHANGE = 2;
  const SHARECHANGE = 4;
  const BACKUPCHANGE = 8;

  async function getTableValue(value, format) {
    try {
      const table = JSON.parse(value);
      const headers = (format && format.headers) || [];
      const pattern = (format && format.pattern) || '{{0}}';
      value = [];
      await Promise.all(table.map(async row => {
        let line = pattern;
        for (let i = 0; i < row.length; i++) {
          const header = headers[i] || {};
          let rowval = row[i];
          if (header.encoding === 'url') {
            rowval = encodeURIComponent(rowval);
          }
          line = line.replace(new RegExp('\\{\\{' + i + '\\}\\}', 'g'), rowval);
        }
        value.push(await app.expand(line));
      }));
      return value.join('join' in format ? format.join : '\n');
    }
    catch (e) {
      console.log(e);
      return '';
    }
  }

  const patterns = [
    {
      p: /^Name$/, f: async (value, match) => {
        if (app._name != value) {
          app._name = value;
          return APPCHANGE;
        }
        return NOCHANGE;
      }
    },
    {
      p: /^EditEnvironment#(.+)$/, f: async (value, match) => {
        const key = match[1];
        let change = NOCHANGE;

        function update(r) {
          if (r) {
            if (r.value !== value) {
              r.value = value;
              change = APPCHANGE;
            }
          }
        }

        update(app._env[key]);
        app._secondary.forEach(secondary => update(secondary._env[key]));

        return change;
      }
    },
    {
      p: /^EditEnvironmentAsCheckbox#(.+)$/, f: async (value, match) => {
        const key = match[1];
        let change = NOCHANGE;

        function update(r) {
          if (r) {
            if (r.value !== value) {
              r.value = value;
              change = APPCHANGE;
            }
          }
        }

        update(app._env[key]);
        app._secondary.forEach(secondary => update(secondary._env[key]));

        return change;
      }
    },
    {
      p: /^EditEnvironmentAsTable#(.+)$/, f: async (value, match) => {
        const key = match[1];
        const tableValue = await getTableValue(value, skeleton.actions.find(action => action.name === key));
        let change = NOCHANGE;

        function update(r) {
          if (r) {
            if (tableValue !== null) {
              r.altValue = value;
            }
            else {
              delete r.altValue;
            }
            if (r.value !== tableValue) {
              r.value = tableValue;
              change = APPCHANGE;
            }
          }
        }

        update(app._env[key]);
        app._secondary.forEach(secondary => update(secondary._env[key]));

        return change;
      }
    },
    {
      p: /^SelectWebsites#(.+)$/, f: async (value, match) => {
        const key = match[1];
        const tableValue = await getTableValue(value, skeleton.actions.find(action => action.name === key));
        let change = NOCHANGE;

        function update(r) {
          if (r) {
            if (tableValue !== null) {
              r.altValue = value;
            }
            else {
              delete r.altValue;
            }
            if (r.value !== tableValue) {
              r.value = tableValue;
              change = APPCHANGE;
            }
          }
        }

        update(app._env[key]);
        app._secondary.forEach(secondary => update(secondary._env[key]));

        return change;
      }
    },
    {
      p: /^SelectNetwork#(.+)$/, f: async (value, match) => {
        const network = match[1];
        const ovalue = app._networks[network];
        if ((network in app._networks) && ovalue !== value) {
          app._networks[network] = value;
          return APPCHANGE;
        }
        return NOCHANGE;
      }
    },
    {
      p: /^SelectDirectory#(.+)$/, f: async (value, match) => {
        const target = match[1];
        let change = NOCHANGE;

        function update(binds) {
          const bind = binds.find(bind => bind.target == target);
          if (bind && bind.src !== value) {
            bind.src = value;
            change = APPCHANGE;
          }
        }

        update(app._binds);
        app._secondary.forEach(secondary => update(secondary._binds));

        return change;
      }
    },
    {
      p: /^EditFile#(.+)$/, f: async (value, match) => {
        const filename = match[1];
        let change = NOCHANGE;

        async function update(files) {
          const file = files.find(file => file.target == filename)
          if (file && file.data !== value) {
            file.data = value;
            if (app._fs) {
              await app._fs.makeFile(file);
            }
            change = APPCHANGE;
          }
        }

        await update(app._files);
        await Promise.all(app._secondary.map(async secondary => update(secondary._files)));

        return change;
      }
    },
    {
      p: /^EditFileAsTable#(.+)$/, f: async (value, match) => {
        const filename = match[1];
        const tableValue = await getTableValue(value, skeleton.actions.find(action => action.name === filename));
        let change = NOCHANGE;

        async function update(files) {
          const file = files.find(file => file.target == filename)
          if (file && (file.data !== tableValue || file.altData !== value)) {
            if (tableValue !== null) {
              file.altData = value;
            }
            else {
              delete file.altData;
            }
            file.data = tableValue;
            if (app._fs) {
              await app._fs.makeFile(file);
            }
            change = APPCHANGE;
          }
        }

        await update(app._files);
        await Promise.all(app._secondary.map(async secondary => update(secondary._files)));

        return change;
      }
    },
    {
      p: /^SelectShares#(.*)#(.*)#(.*)#(.*)$/, f: async (value, match) => {
        const sharesrc = match[2]; // Absolute path of directory we're sharing
        const target = match[3]; // Path of the parent directory we're sharing onto
        const name = value.target.replace(/\//, '.') || match[4]; // The directory name in the parent
        let changed = NOCHANGE;

        function update(binds) {
          const bind = binds.find(bind => bind.target == target);
          if (bind) {
            const shares = bind.shares;
            const idx = shares.findIndex(share => share.src == sharesrc);
            if (value.shared) {
              if (idx !== -1) {
                if (shares[idx].name !== name) {
                  shares[idx].name = name;
                  shares[idx].description = name;
                  changed = SHARECHANGE;
                }
              }
              else {
                shares.push({
                  src: sharesrc,
                  name: name,
                  description: name
                });
                changed = SHARECHANGE;
              }
            }
            else {
              if (idx !== -1) {
                shares.splice(idx, 1);
                changed = SHARECHANGE;
              }
            }
          }
        }

        update(app._binds);
        app._secondary.forEach(secondary => update(secondary._binds));

        return changed;
      }
    },
    {
      p: /^EditShares#(.+)$/, f: async (value, match) => {
        const target = match[1];
        const shares = JSON.parse(value).map(row => {
          return { name: Path.normalize(row[0]) };
        });
        const bind = app._binds.find(bind => bind.target === target);
        if (bind) {
          bind.shares.forEach(share => {
            try {
              if (!shares.find(ns => ns.name === share.name)) {
                const dir = `${bind.src}/${share.name}`;
                if (FS.readdirSync(dir).length !== 0) {
                  // Directory not empty - put it back in the list
                  shares.push(share);
                }
                else {
                  FS.rmdirSync(dir);
                }
              }
            }
            catch (e) {
              console.error(e);
            }
          });
          // New share list
          bind.shares = shares;
        }
        return SHARECHANGE;
      }
    },
    {
      p: /^SelectBackups#(.+)#(.*)/, f: async (value, match) => {
        const backup = {
          appid: match[1],
          target: match[2]
        };
        const idx = app._backups.findIndex(obackup => obackup.appid === backup.appid);
        if (value.backup) {
          if (idx === -1) {
            app._backups.push(backup);
          }
        }
        else if (idx !== -1) {
          app._backups.splice(idx, 1);
        }
        return BACKUPCHANGE;
      }
    },
    {
      p: /^__EditSkeleton$/, f: async (value, match) => {
        const skel = Skeletons.parse(value);
        if (skel) {
          Skeletons.saveLocalSkeleton(skel);
          return SKELCHANGE;
        }
        return NOCHANGE;
      }
    }
  ];

  let changes = {};
  async function save(forceRestart) {
    try {
      let changed = 0;
      for (let property in changes) {
        for (let i = 0; i < patterns.length; i++) {
          const match = property.match(patterns[i].p);
          if (match) {
            changed |= await patterns[i].f(changes[property], match);
          }
        }
      }
      changes = {};

      if (changed || app._status === 'stopped' || forceRestart) {
        const uapp = app;
        if ((changed & SKELCHANGE) !== 0) {
          await uapp.updateFromSkeleton(Skeletons.loadSkeleton(uapp._image, false).skeleton, uapp.toJSON());
          await ConfigBackup.save();
          app = null;
          send({
            type: 'page.reload'
          });
        }
        await uapp.restart(forceRestart ? 'restart' : null);
      }
    }
    catch (e) {
      console.log(e);
    }
  }

  ctx.websocket.on('message', async (msg) => {
    try {
      msg = JSON.parse(msg);
      switch (msg.type) {
        case 'action.change':
          changes[msg.property] = msg.value;
          break;
        case 'app.restart':
          if (app) {
            await save(true);
          }
          break;
        case 'app.save':
          if (app) {
            await save();
          }
          break;
        case 'app.reboot':
          if (app) {
            await app.restart('reboot');
          }
          break;
        case 'app.halt':
          if (app) {
            await app.restart('halt');
          }
          break;
        case 'app.update':
          if (app) {
            app.updateAll();
          }
          break;
        case 'app.delete':
          changes = {};
          const tapp = app;
          app = null;
          await tapp.uninstall();
          await ConfigBackup.save();
          break;
        case 'app.format-disk':
          if (app._image === Images.MINKE) {
            Disks.format(msg.value, () => {
              send({
                type: 'page.reload'
              });
            });
          }
          break;
        case 'app.restore-all':
          if (app._image === Images.MINKE) {
            ConfigBackup.restore(msg.value);
          }
          break;
        case 'app.open-captcha':
          Root.emit('human.verify', { force: true });
          break;
        case 'app.update-download':
          {
            const path = msg.value;
            const file = app._files.find(file => file.target === path);
            if (file && app._fs) {
              app._fs.readFile(file);
            }
            const value = file ? file.data : '';
            send({
              type: 'html.replace',
              selector: `#${path.replace(/[./]/g, '\\$&')}`,
              html: downloadTemplate({
                name: path,
                value: value,
                filename: Path.basename(path)
              })
            });
            break;
          }
        case 'app.update-websites':
          {
            const primary = msg.value;
            const websites = (await app.getAvailableWebsites(primary)).map((site) => {
              return {
                appid: site.app._id,
                name: site.app._name,
                hostname: site.app._safeName(),
                port: site.port.port,
                dns: '',
                published: false
              };
            });
            send({
              type: 'html.update',
              selector: '.websites',
              html: websitesTemplate({
                action: '',
                websites: websites
              })
            });
            break;
          }
        default:
          break;
      }
    }
    catch (_) {
    }
  });

  ctx.websocket.on('close', () => {
    if (app) {
      save();
    }
  });

  ctx.websocket.on('error', () => {
    ctx.websocket.close();
  });

}

function tab(t) {
  let s = '';
  for (; t > 0; t--) {
    s += '  ';
  }
  return s;
}
function toText(o, t) {
  if (Array.isArray(o)) {
    let r = "[";
    for (let i = 0; i < o.length; i++) {
      r += `${i === 0 ? '' : ','}\n${tab(t + 1)}${toText(o[i], t + 1)}`;
    }
    r += `\n${tab(t)}]`;
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
        r += `${i === 0 ? '' : ','}\n${tab(t + 1)}${k[i]}: ${toText(o[k[i]], t + 1)}`;
      }
      r += `\n${tab(t)}}`;
      return r;
      break;
    default:
      break;
  }
  return '';
}

module.exports = {
  HTML: ConfigurePageHTML,
  WS: ConfigurePageWS
};
