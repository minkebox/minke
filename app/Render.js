const VM = require('vm');
const FS = require('fs');
const Handlebars = require('handlebars');
const StreamBuffers = require('stream-buffers');

async function runCmd(app, cmd, parser) {
  const exec = await app._container.exec({
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
    Cmd: typeof cmd === 'string' ? cmd.split(' ') : cmd
  });
  const stream = await exec.start();
  const buffer = new StreamBuffers.WritableStreamBuffer();
  docker.modem.demuxStream(stream.output, buffer, null);
  return new Promise((resolve) => {
    stream.output.on('close', () => {
      const sandbox = { input: buffer.getContentsAsString('utf8'), output: {} };
      VM.runInNewContext(parser || 'output=input', sandbox);
      resolve(sandbox.output);
    });
  });
}

function RenderWatchCmd(app, cmd, parser, template, watch, callback) {
  const ctemplate = template ? Handlebars.compile(template) : (input) => { return input; };
  let iswatching = !watch;
  let enabled = true;
  this.run = async () => {
    enabled = true;
    if (!iswatching) {
      iswatching = true;
      if (watch) {
        FS.watch(watch, {
          persistent: false,
          recursive: false
        }, async () => {
          if (enabled) {
            callback(await this.run());
          }
        });
      }
    }
    return ctemplate(await runCmd(app, cmd, parser));
  }
  this.stopWatching = () => {
    enabled = false;
  }
}

const _Render = {

  create: function(args) {
    let lwatch = null;
    if (args.watch) {
      lwatch = args.app._fs.mapFilenameToLocal(args.watch);
      if (!lwatch) {
        console.error(`Cannot watch ${args.watch} as it isn't reachable from a bind mount`);
        return null;
      }
    }
    return new RenderWatchCmd(args.app, args.cmd, args.parser, args.template, lwatch, args.callback);
  }

};

module.exports = _Render;
