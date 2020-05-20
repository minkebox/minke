const sinon = require('sinon');
const mock = require('mock-require');

module.exports = function() {

beforeEach(async function() {
  let reason = null;
  const mocks = {
    readFileSync: sinon.stub().withArgs('/minke/minke-restart-reason').callsFake(function(name) { return reason; }),
    writeFileSync: sinon.stub().withArgs('/minke/minke-restart-reason').callsFake(function(name, v) { reason = v; })
  };
  mock('fs', mocks);
  const MinkeSetup = mock.reRequire('../../MinkeSetup');
  mock.stop('fs');
  const app = new MinkeSetup(null, {}, {});
  this.MinkeSetup = MinkeSetup;
  this.app = app;
});

afterEach(function() {
  delete this.MinkeSetup;
  delete this.app;
});

}
