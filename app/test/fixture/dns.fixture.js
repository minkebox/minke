
const sinon = require('sinon');
const mock = require('mock-require');

mock('fs', {
  writeFileSync: sinon.fake()
});
mock('child_process', {
  spawnSync: sinon.fake()
});
const DNS = require('../../DNS');
mock.stop('fs');
mock.stop('child_process');

module.exports = function() {

beforeEach(function() {
  this.dns = DNS;
});

afterEach(function() {
  delete this.dns;
});

}
