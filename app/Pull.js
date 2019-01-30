const Path = require('path');
const MinkeApp = require('./MinkeApp');

const _Pull = {

  _downloadImage: async function(name, progress) {
    const tag = 'latest';
    return new Promise((resolve, reject) => {
      const downloading = {};
      const extracting = {};
      docker.pull(`${name}:${tag}`, {}, (err, stream) => {
        if (err) {
          reject(err);
        }
        else {
          docker.modem.followProgress(stream, 
            (err, output) => {
              if (err) {
                progress({ download: 0, extract: 0 });
                reject(err);
              }
              else {
                progress({ download: 100, extract: 100 });
                resolve();
              }
            },
            (event) => {
              //console.log(event);
              const id = event.id;
              if (id) {
                switch (event.status) {
                  case 'Pulling fs layer':
                    downloading[id] = { current: 0, total: 1024 * 1024 }; // Fake
                    extracting[id] = { current: 0, total: 1024 * 1024 }; // Fake
                    break;
                  case 'Downloading':
                    downloading[id] = event.progressDetail;
                    extracting[id] = { current: 0, total: event.progressDetail.total };
                    break;
                  case 'Download complete':
                    downloading[id].current = downloading[id].total;
                    break;
                  case 'Extracting':
                    extracting[id] = event.progressDetail;
                    break;
                  case 'Pull complete':
                  extracting[id].current = extracting[id].total;
                    break;
                  case 'Pulling from ..../....':
                  case 'Pulling fs layer':
                  case 'Waiting':
                  case 'Verifying Checksum':
                  default:
                    break;
                }
              }
              // Calculate % downloaded and extracted
              let dcount = 0;
              const download = 100 * Object.values(downloading).reduce((acc, item) => {
                //console.log(item);
                if (item.total) {
                  acc += item.current / item.total;
                  dcount++;
                }
                return acc;
              }, 0);
              let ecount = 0;
              const extract = 100 * Object.values(extracting).reduce((acc, item) => {
                if (item.total) {
                  acc += item.current / item.total;
                  ecount++;
                }
                return acc;
              }, 0);
              if (progress) {
                progress({ download: dcount ? Math.ceil(download / dcount) : 0, extract: ecount ? Math.ceil(extract / ecount) : 0 });
              }
            }
          )
        }
      });
    });
  },

  loadImage: async function(image, inProgress) {
    let info;
    try {
      const img = docker.getImage(image);
      info = await img.inspect();
    }
    catch (_) {
      try {
        await this._downloadImage(image, (progress) => {
          if (inProgress) {
            inProgress(progress);
          }
        });
      }
      catch (e) {
        console.error(`Failed to find image: ${image}`);
        return null;
      }
      const img = docker.getImage(image);
      info = await img.inspect();
    }

    const apps = MinkeApp.getApps();
    let name = null;
    for (let i = 0; ; i++) {
      name = `MyApp${i}`;
      if (!apps.find(app => name === app._name)) {
        break;
      }
    }
  
    return {
      name: name,
      description: '',
      image: image,
      args: '',
      env: [],
      features: {},
      ports: Object.keys(info.ContainerConfig.ExposedPorts || {}).map((key) => {
        return {
          target: key,
          host: parseInt(key),
          protocol: key.split('/')[1].toUpperCase(),
          nat: false,
          mdns: {
            type: `._${key.split('/')[1].toLowerCase()}`,
            txt: {
              description: ''
            }
          }
        }
      }),
      binds: Object.keys(info.ContainerConfig.Volumes || {}).map((key) => {
        return {
          host: Path.normalize(`/dir/${key}`),
          target: key,
          shareable: false,
          shared: false,
          description: ''
        }
      }),
      files: [],
      networks: {
        primary: 'home',
        secondary: 'none',
      },
      monitor: {
        cmd: '',
        polling: 0,
        watch: '',
        parser: '',
        template: ''
      }
    }
  }

};

module.exports = _Pull;