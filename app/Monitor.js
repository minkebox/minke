const VM = require('vm');
const FS = require('fs');
const Handlebars = require('handlebars');
const CSS = require('svgdom-css');
const Chartist = require('chartist');

const DEFAULT_POLLING = 60; // Default polling is 60 seconds
const DEFAULT_PARSER = 'output=input;'
const DEFAULT_TEMPLATE = function(data) { return data; };

function debounce(func, timeout) {
  let timer = null;
  return function() {
    clearTimeout(timer);
    timer = setTimeout(function() {
      timer = null;
      func.apply(null, arguments);
    }, timeout);
  }
}

async function runCmd(app, cmd) {
  const exec = await app._container.exec({
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
    Env: app._fullEnv,
    Cmd: [ 'sh', '-c', cmd ]
  });
  const stream = await exec.start();
  let buffer = '';
  docker.modem.demuxStream(stream.output, {
    write: (data) => {
      //console.log('stdout', buffer.toString('utf8'));
      buffer += data.toString('utf8');
    }
  }, null);
  return new Promise((resolve) => {
    stream.output.on('close', () => {
      resolve(buffer);
    });
  });
}

function WatchCmd(app, cmd, parser, template, watch, polling, callback) {
  const ctemplate = template ? Handlebars.compile(template) : DEFAULT_TEMPLATE;
  this.watcher = null;
  this.clock = null;
  const dowork = debounce(async () => {
    callback(await this.run());
  }, 10);
  const listener = async (event) => {
    if (event === 'rename') {
      this.watcher.close();
      this.watcher = FS.watch(watch, { persistent: false, recursive: false }, listener);
    }
    dowork();
  }
  const sandbox = { input: null, output: null, props: { homeIP: app._homeIP }};
  VM.createContext(sandbox);
  this.run = async () => {
    if (callback) {
      if (!this.watcher && watch) {
        this.watcher = FS.watch(watch, { persistent: false, recursive: false }, listener);
      }
      if (!this.clock && (!watch || polling !== 0)) {
        this.clock = setInterval(listener, (polling || DEFAULT_POLLING) * 1000);
      }
    }
    try {
      sandbox.input = await runCmd(app, cmd);
      sandbox.output = {};
      VM.runInContext(`(function(){${parser || DEFAULT_PARSER}})()`, sandbox);
      if (sandbox.output.graph && ctemplate !== DEFAULT_TEMPLATE) {
        for (let name in sandbox.output.graph) {
          const graph = sandbox.output.graph[name];
          if (graph.series) {
            graph.series = JSON.parse(JSON.stringify(graph.series)); // Data came out of a different context so this "cleans" it.
            sandbox.output.graph[name] = await _generateGraph(graph);
          }
        }
      }
      return ctemplate(sandbox.output);
    }
    catch (e) {
      console.error(e);
      return '';
    }
  }
  this.stop = () => {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
  }
}

async function _generateGraph(graph) {
  return new Promise((resolve, reject) => {
    try {
      const div = document.createElement('div');
      const options = Object.assign({
        width: '300px',
        height: '300px',
        axisX: { showLabel: false, showGrid: false, offset: 0 },
        axisY: { showLabel: false, showGrid: false, offset: 0 },
        fullWidth: true,
        showPoint: false
      }, graph.options);
      const chart = new Chartist[graph.type || 'Line'](div, { series: graph.series, labels: graph.labels }, options);
      chart.on('created', () => {
        resolve(div.innerHTML);
      });
    }
    catch (e) {
      reject(e);
    }
  });
}

const _Monitor = {

  create: function(args) {
    let lwatch = null;
    if (args.watch) {
      lwatch = args.app._fs.mapFilenameToLocal(args.watch);
      if (lwatch && !FS.existsSync(lwatch)) {
        FS.closeSync(FS.openSync(lwatch, 'w'));
      }
    }
    return new WatchCmd(args.app, args.cmd, args.parser, args.template, lwatch, args.polling, args.callback);
  }

};

module.exports = _Monitor;
