const VM = require('vm');
const FS = require('fs');
const Handlebars = require('handlebars');

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
      buffer += data.toString('utf8');
    }
  }, null);
  return new Promise((resolve) => {
    stream.output.on('close', () => {
      resolve(buffer);
    });
  });
}

function WatchCmd(app, cmd, parser, template, polling) {
  const ctemplate = template ? Handlebars.compile(template) : DEFAULT_TEMPLATE;
  const sandbox = { input: null, output: null, state: null, props: { homeIP: app._homeIP, colors: DEFAULT_COLORS }};
  VM.createContext(sandbox);
  const extractor = VM.compileFunction(`(function(){try{${parser || DEFAULT_PARSER}}catch(_){}})()`, [], { parsingContext: sandbox });
  this.update = async () => {
    let html = '';
    if (app._container) {
      try {
        sandbox.input = await runCmd(app, cmd);
        if (sandbox.input != '') {
          sandbox.output = {};
          extractor();
          if (sandbox.output.graph && ctemplate !== DEFAULT_TEMPLATE) {
            for (let name in sandbox.output.graph) {
              const graph = sandbox.output.graph[name];
              if (graph) {
                sandbox.output.graph[name] = _generateGraph2(graph);
              }
            }
          }
          html = ctemplate(sandbox.output);
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

let graphId = 1;

function _generateGraph2(graph) {
  const id = `gid${graphId++}`;
  const width = 'width' in graph ? `width: ${graph.width};` : '';
  return `
    <div style="position: relative; ${width} height: ${graph.height || '250px'}">
      <canvas id="${id}"></canvas>
    </div>
    <script>
    window.addChart("${id}", new Chart(document.getElementById("${id}").getContext("2d"), ${JSON.stringify(graph)}));
    </script>
  `;
}

const _Monitor = {

  create: function(args) {
    return new WatchCmd(args.app, args.cmd, args.parser, args.template, args.polling);
  }

};

module.exports = _Monitor;
