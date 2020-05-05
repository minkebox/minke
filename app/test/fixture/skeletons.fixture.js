const sinon = require('sinon');
const mock = require('mock-require');
const FS = require('fs');


module.exports = function() {

mock('fs', {
  mkdirSync: sinon.fake(),
  readFileSync: FS.readFileSync,
  readdirSync: FS.readdirSync,
  existsSync: FS.existsSync,
  lstatSync: FS.lstatSync
});
const Skeletons = mock.reRequire('../../Skeletons');
mock.stop('fs');

beforeEach(async function() {
  this.skeletons = Skeletons;
});

afterEach(function() {
  delete this.skeletons;
});

}
