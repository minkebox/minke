const MinkeSetup = require('../../MinkeSetup');

module.exports = function() {

beforeEach(async function() {
  const app = new MinkeSetup(null, {}, {})
  this.app = app;
});

afterEach(function() {
  delete this.app;
});

}
