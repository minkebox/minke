
async function runCmd(app, cmd) {
  const exec = await app._container.exec({
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
    Env: Object.keys(app._fullEnv).map(key => `${key}=${app._fullEnv[key].value}`),
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
    stream.output.on('close', () => {
      resolve(buffer);
    });
  });
}

const Monitor = {

  create: function(args) {
    return {
      init: args.init.replace(/{{ID}}/g, args.app._id),
      update: async () => {
        return await runCmd(args.app, args.cmd);
      }
    }
  }

};

module.exports = Monitor;
