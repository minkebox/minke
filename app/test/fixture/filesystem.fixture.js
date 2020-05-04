const sinon = require('sinon');
const mock = require('mock-require');

module.exports = function() {

beforeEach(async function() {
  const mocks = {
    mkdirSync: sinon.spy(),
    existsSync: sinon.fake.returns(false),
    writeFileSync: sinon.spy()
  };
  mock('fs', mocks);
  const Filesystem = mock.reRequire('../../Filesystem');
  mock.stop('fs');
  this.fs = Filesystem.create(this.app);
  this.fs.mocks = mocks;
});

afterEach(function() {
  delete this.fs;
});

}
