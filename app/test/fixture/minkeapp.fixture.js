const sinon = require('sinon');
const mock = require('mock-require');

module.exports = function() {

beforeEach(async function() {
  mock('fs', {
    mkdirSync: sinon.fake(),
    readdirSync: sinon.fake.returns([]),
    existsSync: sinon.fake.returns(false)
  });
  const MinkeApp = mock.reRequire('../../MinkeApp');
  mock.stop('fs');

  MinkeApp._network = { network: {} };
  const app = await (new MinkeApp().createFromJSON({ binds: [], vars: '' }));
  app._globalId = '1FB44E7C-7E63-4739-A1F6-569220469E8B';
  await app.createJS();
  this.app = app;
});

afterEach(function() {
  delete this.app;
});

}
