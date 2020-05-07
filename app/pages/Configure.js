const FS = require('fs');
const Path = require('path');
const UUID = require('uuid/v4');
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
const Build = require('../Build');

const MinkeBoxConfiguration = 'minke'; // MinkeSetup._id
const SKELETON_ERROR = {
  type: 'error',
  skeleton: {
    name: 'Missing Skeleton',
    description: 'Missing Skeleton',
    actions: [],
    properties: []
  }
};

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
  const skel = (await Skeletons.loadSkeleton(app.skeletonId(), true)) || SKELETON_ERROR;
  if (skel.type === 'error') {
    console.error(`Failed to load skeleton: ${app._image}`);
  }
  const skeleton = skel.skeleton;
  const minkeConfig = app._image == Images.MINKE;

  async function expandString(text) {
    return await app.expandString(text);
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
    description: await expandString(skeleton.description),
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
            return Object.assign({}, action, { text: await expandString(action.text) });
          }
        case 'Help':
          {
            help = true;
            return Object.assign({}, action, { text: await expandString(action.text) });
          }
        case 'NavButton':
          {
            navbuttons.push({
              name: action.name,
              link: await expandString(action.url),
              linktarget: '_blank'
            });
            return action;
          }
        case 'EditEnvironment':
          {
            let value = '';
            let placeholder = '';
            if (app._vars[action.name]) {
              value = app._vars[action.name].value;
              placeholder = await expandString(app._vars[action.name].defaultValue);
            }
            properties[`${action.type}#${action.name}`] = value;
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, value: value, placeholder: placeholder, options: action.options }, action, { description: await expandString(action.description) });
          }
        case 'EditEnvironmentAsCheckbox':
          {
            let value = false;
            if (app._vars[action.name]) {
              value = app._vars[action.name].value;
            }
            properties[`${action.type}#${action.name}`] = value;
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.checked)`, value: value }, action, { description: await expandString(action.description) });
          }
        case 'EditEnvironmentAsTable':
          {
            let value = [];
            if (app._vars[action.name] && app._vars[action.name].value) {
              value = app._vars[action.name].value;
              // Fix up the data so we have at least enough for to match the headers
              // (otherwise it looks bad when we display it)
              const hlen = action.headers.length;
              value.forEach(v => {
                while (v.length < hlen) {
                  v.push('');
                }
              });
            }
            return Object.assign({ action: `${action.type}#${action.name}`, value: value, controls: true }, action, { description: await expandString(action.description) });
          }
        case 'SelectWebsites':
          {
            let currentSites = [];
            if (app._vars[action.name] && app._vars[action.name].value) {
              currentSites = app._vars[action.name].value;
            }

            const websites = (await app.getAvailableWebsites(app._networks.primary.name)).map(site => {
              const match = currentSites.find(cs => cs[0] === site.app._id);
              let ip = app._networks.primary.name === site.app._networks.primary.name ? site.app._defaultIP : site.app._secondaryIP;
              return {
                appid: site.app._id,
                name: site.app._name,
                hostname: site.app._safeName(),
                ip: ip,
                ip6: site.app.getSLAACAddress(),
                port: site.port.port,
                dns: match ? match[3] : '',
                published: match ? !!match[4] : false
              };
            });
            return Object.assign({ action: `${action.type}#${action.name}`, websites: websites }, action, { description: await expandString(action.description) });
          }
        case 'SelectNetwork':
          {
            const networks = [{ _id: 'none', name: 'none' }].concat(app.getAvailableNetworks());
            const network = app._networks[action.name].name || 'none';
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
            }, action, { description: await expandString(action.description) });
          }
        case 'ShowFileAsTable':
          {
            if (app._fs) {
              try {
                app.setVariable(action.name, await app._fs.readFromFile(action.name));
              }
              catch (_) {
              }
            }
            const data = app._vars[action.name].value;
            return Object.assign({ value: data }, action, { description: await expandString(action.description) });
          }
        case 'ShowFile':
          {
            if (app._fs) {
              app.setVariable(action.name, await app._fs.readFromFile(action.name));
            }
            const data = app._vars[action.name].value;
            return Object.assign({ value: data }, action, { description: await expandString(action.description) });
          }
        case 'DownloadFile':
        case 'EditFile':
          {
            if (app._fs) {
              app.setVariable(action.name, await app._fs.readFromFile(action.name));
            }
            const data = app._vars[action.name].value;
            return Object.assign({ action: `window.action('${action.type}#${action.name}',this.value)`, value: data, filename: Path.basename(action.name) }, action, { description: await expandString(action.description) });
          }
        case 'EditFileAsTable':
          {
            let value = [];
            if (app._vars[action.name] && app._vars[action.name].value) {
              value = app._vars[action.name].value;
              // Fix up the data so we have at least enough for to match the headers
              // (otherwise it looks bad when we display it)
              const hlen = action.headers.length;
              value.forEach(v => {
                while (v.length < hlen) {
                  v.push('');
                }
              });
            }
            return Object.assign({ action: `${action.type}#${action.name}`, value: value, controls: true }, action, { description: await expandString(action.description) });
          }
        case 'SelectDirectory':
          {
            let selected = '';
            if (app._vars[action.name] && app._vars[action.name].value) {
              selected = app._vars[action.name].value;
            }

            const shareables = [];
            let found = false;

            // Generate a list of all shareables (making the currently selected one as necessary)
            const allShares = app.getAvailableShareables();
            allShares.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);

            for (let i = 0; i < allShares.length; i++) {
              const shareable = allShares[i];
              const shares = [];
              for (let j = 0; j < shareable.shares.length; j++) {
                const bind = shareable.shares[j];
                for (let k = 0; k < bind.shares.length; k++) {
                  const share = bind.shares[k];
                  const name = Path.normalize(`${shareable.app._name}/${await shareable.app.expandString(bind.target)}/${share.name}/`).slice(0, -1).replace(/\//g, '.');
                  const src = Path.normalize(`${await shareable.app.expandPath(bind.src)}/${share.name}/`).slice(0, -1);
                  const value = src == selected;
                  found |= value;
                  shares.push({
                    name: name,
                    src: src,
                    description: await expandString(share.description),
                    value: value
                  });
                }
              }
              if (shares.length) {
                shareables.push({
                  app: shareable.app,
                  shares: shares
                });
              }
            }

            // Add native shareables
            const nativedirs = Filesystem.getNativeDirectories();
            if (nativedirs.length) {
              shareables.push({
                app: {
                  _id: 'native',
                  _name: 'Native'
                },
                shares: nativedirs.map(dir => {
                  const value = dir.src == selected;
                  found |= value;
                  return {
                    name: Path.basename(dir.src),
                    src: dir.src,
                    description: dir.src,
                    value: value
                  };
                })
              });
            }

            // Local fallback
            shareables.unshift({
              app: app,
              shares: [{
                name: 'Local',
                src: Filesystem.getNativePath(app._id, 'store', `/vol/${action.name}`),
                description: 'Local',
                value: !found
              }]
            });

            return Object.assign({ action: `window.action('${action.type}#${action.name}',event.target.value)`, shareables: shareables }, action, { description: await expandString(action.description) });
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
            }, action, { description: await expandString(action.description) });
          }
        case 'SelectShares':
          {
            let selected = [];
            if (app._vars[action.name] && app._vars[action.name].value) {
              selected = app._vars[action.name].value;
            }

            const shareables = [];

            // Generate a list of all shareables (making the currently selected ones)
            const allShares = app.getAvailableShareables();
            allShares.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);

            for (let i = 0; i < allShares.length; i++) {
              const shareable = allShares[i];
              const shares = [];
              for (let j = 0; j < shareable.shares.length; j++) {
                const bind = shareable.shares[j];
                for (let k = 0; k < bind.shares.length; k++) {
                  const share = bind.shares[k];
                  const name = Path.normalize(`${shareable.app._name}/${await shareable.app.expandString(bind.target)}/${share.name}/`).slice(0, -1).replace(/\//g, '.');
                  const src = Path.normalize(`${await shareable.app.expandPath(bind.src)}/${share.name}/`).slice(0, -1);
                  const isShared = selected.find(select => select.src === src);
                  shares.push({
                    name: name,
                    altname: !isShared || isShared.name == name ? null : isShared.name,
                    description: await expandString(share.description),
                    action: `window.share('${action.type}#${shareable.app._id}#${src}#${action.name}#${name}',this)`,
                    value: !!isShared
                  });
                }
              }
              if (shares.length) {
                shareables.push({
                  app: shareable.app,
                  shares: shares
                });
              }
            }

            // Add native shareables
            const nativedirs = Filesystem.getNativeDirectories();
            if (nativedirs.length) {
              shareables.push({
                app: {
                  _id: 'native',
                  _name: 'Native'
                },
                shares: nativedirs.map(dir => {
                  const name = Path.basename(dir.src);
                  const isShared = selected.find(select => select.src === dir.src);
                  return {
                    name: name,
                    altname: !isShared || isShared.name == name ? null : isShared.name,
                    description: dir.src,
                    action: `window.share('${action.type}#native#${dir.src}#${action.name}#${name}',this)`,
                    value: !!isShared
                  };
                })
              });
            }

            return Object.assign({ shareables: shareables }, action, { description: await expandString(action.description) })
          }
        case 'SelectBackups':
          {
            let selected = [];
            if (app._vars[action.name] && app._vars[action.name].value) {
              selected = app._vars[action.name].value;
            }

            const allBackups = app.getAvailableBackups();
            allBackups.sort((a, b) => a.app._name < b.app._name ? -1 : a.app._name > b.app._name ? 1 : 0);

            const backups = [];
            allBackups.forEach(backup => {
              if (backup.app._id === MinkeBoxConfiguration) {
                backups.unshift({
                  id: MinkeBoxConfiguration,
                  name: `${backup.app._name} (Configuration)`,
                  action: `window.backup('${action.type}#${MinkeBoxConfiguration}#${action.name}',this)`,
                  value: !!selected.find(select => select.appid === MinkeBoxConfiguration)
                });
              }
              else {
                backups.push({
                  id: backup.app._id,
                  name: backup.app._name,
                  action: `window.backup('${action.type}#${backup.app._id}#${action.name}',this)`,
                  value: !!selected.find(select => select.appid === backup.app._id)
                });
              }
            });

            return Object.assign({ backups: backups }, action, { description: await expandString(action.description) });
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
    skeletonType: !minkeConfig && skel.type === 'local' ? 'Personal' : null,
    properties: JSON.stringify(properties),
    skeletonAsText: Skeletons.toString(skeleton),
    navbuttons: navbuttons,
    firstUse: properties.FirstUse,
    NoSystemControl: properties.NoSystemControl,
    Build: minkeConfig && MinkeApp.getAdvancedMode() ? Build : null,
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

  const NOCHANGE = 0;
  const APPCHANGE = 1;
  const SKELCHANGE = 2;
  const SHARECHANGE = 4;
  const BACKUPCHANGE = 8;

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
      p: /^(EditEnvironment|SelectDirectory|EditFile)#(.+)$/, f: async (value, match) => {
        const key = match[2];
        return app.setVariable(key, value) ? APPCHANGE : NOCHANGE;
      }
    },
    {
      p: /^EditEnvironmentAsCheckbox#(.+)$/, f: async (value, match) => {
        const key = match[1];
        return app.setVariable(key, !!value) ? APPCHANGE : NOCHANGE;
      }
    },
    {
      p: /^(EditEnvironmentAsTable|SelectWebsites|EditFileAsTable)#(.+)$/, f: async (value, match) => {
        const key = match[2];
        return app.setVariable(key, value) ? APPCHANGE : NOCHANGE;
      }
    },
    {
      p: /^SelectShares#(.*)#(.*)#(.*)#(.*)$/, f: async (value, match) => {
        const sharesrc = match[2]; // Absolute path of directory we're sharing
        const target = match[3]; // Path of the parent directory we're sharing onto
        const name = value.target.replace(/\//, '.') || match[4]; // The directory name in the parent

        if (app._vars[target]) {
          const current = [].concat(app._vars[target].value);
          const idx = current.findIndex(curr => curr.src === sharesrc);
          if (value.shared && idx === -1) {
            current.push({
              src: sharesrc,
              name: name
            });
          }
          else if (value.shared && idx !== -1 && current[idx].name !== name) {
            current[idx].name = name;
          }
          else if (!value.shared && idx !== -1) {
            current.splice(idx, 1);
          }
          return app.setVariable(target, current) ? SHARECHANGE : NOCHANGE;
        }

        return NOCHANGE;
      }
    },
    {
      p: /^SelectBackups#(.+)#(.*)/, f: async (value, match) => {
        const appid = match[1];
        const target = match[2];

        if (app._vars[target]) {
          const current = app._vars[target].value;
          const idx = current.findIndex(curr => curr.appid === appid);
          if (value.backup && idx === -1) {
            current.push({
              appid: appid,
              target: target
            });
            return BACKUPCHANGE;
          }
          else if (!value.backup && idx !== -1) {
            current.splice(idx, 1);
            return BACKUPCHANGE;
          }
        }
        return BACKUPCHANGE
      }
    },
    {
      p: /^SelectNetwork#(.+)$/, f: async (value, match) => {
        const network = match[1];
        const ovalue = app._networks[network].name;
        if ((network in app._networks) && ovalue !== value) {
          app._networks[network].name = value;
          return APPCHANGE;
        }
        return NOCHANGE;
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
          // (Re)Create all the current shares
          shares.forEach(share => FS.mkdirSync(`${bind.src}/${share.name}`, { recursive: true }));
          // Remove any which are no longer in the list and empty
          bind.shares.forEach(share => {
            try {
              if (!shares.find(ns => ns.name === share.name)) {
                const dir = `${bind.src}/${share.name}`;
                if (FS.existsSync(dir)) {
                  if (FS.readdirSync(dir).length !== 0) {
                    // Directory not empty - put it back in the list
                    shares.push(share);
                  }
                  else {
                    FS.rmdirSync(dir);
                  }
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
      p: /^__EditSkeleton$/, f: async (value, match) => {
        const skel = Skeletons.parse(value);
        if (skel) {
          // Make sure skeleton has unique id
          if (!skel.uuid) {
            skel.uuid = UUID().toUpperCase();
          }
          else {
            // If skeleton exists, we can update in-place if it's already local. Otherwise
            // we assigned it a new id.
            const existing = Skeletons.loadSkeleton(skel.uuid, false);
            if (existing && existing.type !== 'local') {
              skel.uuid = UUID().toUpperCase();
            }
          }
          Skeletons.saveLocalSkeleton(skel);
          // Make sure app points to the correct skeleton
          app._skeletonId = skel.uuid;
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
          await uapp.updateFromSkeleton(Skeletons.loadSkeleton(uapp.skeletonId(), false).skeleton, uapp.toJSON());
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
            let value = '';
            const path = msg.value;
            if (app._fs) {
              value = await app._fs.readFromFile(path);
            }
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
            const websites = (await app.getAvailableWebsites(primary)).map(site => {
              let ip = primary === site.app._networks.primary.name ? site.app._defaultIP : site.app._secondaryIP;
              return {
                appid: site.app._id,
                name: site.app._name,
                hostname: site.app._safeName(),
                ip: ip,
                ip6: site.app.getSLAACAddress(),
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
    catch (e) {
      console.error(e);
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
