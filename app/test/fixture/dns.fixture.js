
const proxyquire = require('proxyquire');
const sinon = require('sinon');

const DNS = proxyquire('../../DNS', {
  fs: {
    writeFileSync: sinon.fake()
  },
  child_process: {
    spawnSync: sinon.fake()
  }
});

module.exports = function() {

beforeEach(function() {
  this.dns = DNS;
});

afterEach(function() {
  delete this.dns;
});

}
