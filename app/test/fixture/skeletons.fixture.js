const sinon = require('sinon');
const mock = require('mock-require');
const FS = require('fs');

mock('fs', {
  mkdirSync: sinon.fake(),
  readFileSync: FS.readFileSync,
  readdirSync: FS.readdirSync, // sinon.fake.returns([]),
  existsSync: FS.existsSync, // sinon.fake.returns(false)
});
const Skeletons = mock.reRequire('../../Skeletons');
mock.stop('fs');

module.exports = function() {

  beforeEach(async function() {
    this.skeletons = Skeletons;
  });

  afterEach(function() {
    delete this.skeletons;
  });

  }
