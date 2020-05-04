
const sinon = require('sinon');
const mock = require('mock-require');

module.exports = function() {

beforeEach(function() {
  mock('fs', {
    writeFileSync: sinon.fake()
  });
  mock('child_process', {
    spawnSync: sinon.fake()
  });
  const DNS = mock.reRequire('../../DNS');
  mock.stop('fs');
  mock.stop('child_process');
  this.dns = DNS;
});

afterEach(function() {
  delete this.dns;
});

}
