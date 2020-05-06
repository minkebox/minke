const TIMEOUT = 2000; // 2 seconds

async function runCmd(container, cmd) {
  const exec = await container.exec({
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
    Cmd: [ 'sh', '-c', cmd ]
  });
  const stream = await exec.start();
  let buffer = '';
  docker.modem.demuxStream(stream.output, {
    write: (data) => {
      buffer += data.toString('utf8');
    }
  }, null);
  return new Promise(resolve => {
    let timeout = setTimeout(() => {
      if (!timeout) {
        timeout = null;
        try {
          stream.output.destroy();
        }
        catch (_) {
        }
        resolve('');
      }
    }, TIMEOUT);
    stream.output.on('close', () => {
      if (!timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      resolve(buffer);
    });
  });
}

const Monitor = {

  create: function(args) {
    const container = args.target === 'helper' ? args.app._helperContainer : args.app._container;
    const cmd = args.cmd;
    return {
      init: args.init.replace(/{{ID}}/g, args.app._id),
      update: async () => {
        return await runCmd(container, cmd);
      }
    }
  }

};

module.exports = Monitor;
