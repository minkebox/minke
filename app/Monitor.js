const Handlebars = require('handlebars');
const JSInterpreter = require('js-interpreter');

const DEFAULT_POLLING = 60; // Default polling is 60 seconds
const ERROR_POLLING = 5; // Poll quickly if the last poll errored
const DEFAULT_PARSER = 'output=input;'
const DEFAULT_TEMPLATE = function(data) { return data; };
const DEFAULT_COLORS = [
  '#fd0a1a',
  '#ffd73e',
  '#278b30',
  '#b12427',
  '#808020',
  '#fd471f',
  '#41b376',
  '#fd1a91',
  '#88cce7',
  '#19196b',
  '#efad5a',
  '#d85452'
];
const JSINTERPRETER_STEPS = 5000;

let graphId = 1;

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
      buffer += data.toString('utf8');
    }
  }, null);
  return new Promise(resolve => {
    stream.output.on('close', () => {
      resolve(buffer);
    });
  });
}

function WatchCmd(app, cmd, parser, template, polling) {
  const ctemplate = template ? Handlebars.compile(template) : DEFAULT_TEMPLATE;
  let state = null;
  const extractor = `(function(){${parser || DEFAULT_PARSER}})()`;
  this.update = async () => {
    let html = '';
    if (app._container) {
      try {
        const input = await runCmd(app, cmd);
        if (input != '') {
          const js = new JSInterpreter(extractor, (intr, glb) => {
            intr.setProperty(glb, 'input', input);
            intr.setProperty(glb, 'output', new JSInterpreter.Object(null));
            intr.setProperty(glb, 'state', intr.nativeToPseudo(state));
          });
          js.REGEXP_MODE = 1;
          let output = {};
          try {
            for (let i = 0; i < JSINTERPRETER_STEPS && js.step(); i++)
              ;
            if (js.step()) {
              console.info(`Failed to complete code for ${app._name}`);
            }
            state = js.pseudoToNative(js.getProperty(js.globalObject, 'state'));
            output = js.pseudoToNative(js.getProperty(js.globalObject, 'output'));
          }
          catch (e) {
            console.log(`Application: ${app._name}`);
            console.info(e);
            console.info(js.stateStack);
          }
          if (output.graph && ctemplate !== DEFAULT_TEMPLATE) {
            for (let name in output.graph) {
              const graph = output.graph[name];
              if (graph) {
                const id = `gid${graphId++}`;
                const width = 'width' in graph ? `width: ${graph.width};` : '';
                const height = 'height' in graph ? `height: ${graph.height};` : 'height: 250px;';
                output.graph[name] = `<div style="position: relative; ${width} ${height}"><canvas id="${id}"></canvas></div><script>window.addChart("${id}", new Chart(document.getElementById("${id}").getContext("2d"), ${JSON.stringify(graph)}));</script>`;
              }
            }
          }
          html = ctemplate(output);
        }
      }
      catch (e) {
        console.error(e);
      }
    }
    return `
      ${html}
      <script>
      window.monitor('${app._id}',${(html == '' ? ERROR_POLLING : (polling || DEFAULT_POLLING)) * 1000});
      </script>
    `;
  }
}

function WatchCmd2(app, cmd, init) {
  this.init = init.replace(/{{ID}}/g, app._id);
  this.update2 = async () => {
    return await runCmd(app, cmd);
  }
}

const _Monitor = {

  create: function(args) {
    if (args.init) {
      return new WatchCmd2(args.app, args.cmd, args.init);
    }
    else {
      return new WatchCmd(args.app, args.cmd, args.parser, args.template, args.polling);
    }
  }

};

module.exports = _Monitor;
