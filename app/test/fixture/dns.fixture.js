
const mock = require('mock-require');
const sinon = require('sinon');

mock('fs', {
  writeFileSync: sinon.fake(),
});
const DNS = require('../../DNS');
mock.stop('fs');
mock('child_process', {
  spawnSync: sinon.fake()
});
mock.stop('child_process');

module.exports = function() {

beforeEach(function() {
  this.dns = DNS;
});

afterEach(function() {
  delete this.dns;
});

}
