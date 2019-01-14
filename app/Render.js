const VM = require('vm');
const FS = require('fs');
const Handlebars = require('handlebars');

const DEFAULT_POLLING = 60; // Default polling is 60 seconds

async function runCmd(app, cmd) {
  const exec = await app._container.exec({
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
    Cmd: typeof cmd === 'string' ? cmd.split(' ') : cmd
  });
  const stream = await exec.start();
  let buffer = '';
  docker.modem.demuxStream(stream.output, {
    write: (data) => {
      buffer += data.toString('utf8');
    }
  }, null);
  return new Promise((resolve) => {
    stream.output.on('close', () => {
      resolve(buffer);
    });
  });
}

function RenderWatchCmd(app, cmd, parser, template, watch, polling, callback) {
  const ctemplate = template ? Handlebars.compile(template) : (input) => { return input; };
  let watcher = null;
  let clock = null;
  const listener = async () => {
    callback(await this.run());
  }
  this.run = async () => {
    if (callback) {
      if (watch && !watcher) {
        watcher = FS.watch(watch, { persistent: false, recursive: false }, listener);
      }
      else if (!watch && !clock) {
        clock = setInterval(listener, polling * 1000);
      }
    }
    try {
      const sandbox = { input: await runCmd(app, cmd), output: {} };
      VM.runInNewContext(parser || 'output=input', sandbox);
      return ctemplate(sandbox.output);
    }
    catch (e) {
      console.error(e);
      return '';
    }
  }
  this.stop = () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (clock) {
      clearInterval(clock);
      clock = null;
    }
  }
}

const _Render = {

  create: function(args) {
    let lwatch = null;
    if (args.watch) {
      lwatch = args.app._fs.mapFilenameToLocal(args.watch);
      if (!lwatch && !args.polling) {
        console.warn(`Cannot watch ${args.watch} and no polling interval given - falling back on default polling`);
      }
      if (!FS.existsSync(lwatch)) {
        FS.closeSync(FS.openSync(lwatch, 'w'));
      }
    }
    return new RenderWatchCmd(args.app, args.cmd, args.parser, args.template, lwatch, args.polling || DEFAULT_POLLING, args.callback);
  }

};

module.exports = _Render;
