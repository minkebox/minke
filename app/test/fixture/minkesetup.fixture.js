const mock = require('mock-require');

module.exports = function() {

beforeEach(async function() {
  const MinkeSetup = mock.reRequire('../../MinkeSetup');
  const app = new MinkeSetup(null, {}, {})
  this.app = app;
});

afterEach(function() {
  delete this.app;
});

}
