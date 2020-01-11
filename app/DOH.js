const HTTP2 = require('http2');
const FS = require('fs');
const Config = require('./Config');
const Playdoh = require('./utils/Playdoh').playdoh;

function DOHServer() {
  const DOH = Playdoh({
    protocol: 'udp4',
    localAddress: '0.0.0.0',
    resolverAddress: '127.0.0.1',
    resolverPort: 53,
    timeout: 5000,
    serverName: Config.DOH_SERVER_NAME,
    path: Config.DOH_SERVER_PATH
  });
  const DOHServer = HTTP2.createSecureServer({
    key: FS.readFileSync(`/app/certs/${Config.DOH_SERVER_CERT}`),
    cert: FS.readFileSync(`/app/certs/${Config.DOH_SERVER_CERT}`)
  }, async (request, response) => {
    try {
      await DOH(request, response, (err) => {
        if (err) {
          response.statusCode = err.statusCode;
        }
        else {
          response.statusCode = 404;
        }
        response.end();
      });
    }
    catch (e) {
      response.statusCode = 500;
      response.end();
    }
  });
  DOHServer.listen(Config.DOH_SERVER_PORT);
}

module.exports = DOHServer;
