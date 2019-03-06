const Path = require('path');
const MinkeApp = require('./MinkeApp');

const TAG = 'latest';

const _Pull = {

  _pullStream: null,

  _downloadImage: async function(name, progress) {
    return new Promise((resolve, reject) => {
      const downloading = {};
      const extracting = {};
      docker.pull(`${name}:${TAG}`, {}, (err, stream) => {
        if (err) {
          reject(err);
        }
        else {
          if (this._pullStream) {
            this._pullStream.destroy();
          }
          this._pullStream = stream;
          docker.modem.followProgress(stream, 
            (err, output) => {
              if (err) {
                progress({ download: 0, extract: 0 });
                reject(err);
              }
              else {
                // Actually check it downloaded. If the stream terminated early we don't get an error.
                docker.getImage(name).inspect().then(() => {
                  progress({ download: 100, extract: 100 });
                  resolve();
                }).catch((e) => {
                  reject(e);
                });
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
    return image;
  },

  cancel: function() {
    if (this._pullStream) {
      this._pullStream.destroy();
      this._pullStream = null;
    }
  }

};

module.exports = _Pull;