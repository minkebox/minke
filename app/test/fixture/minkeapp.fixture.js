const MinkeApp = require('../../MinkeApp');

module.exports = function() {

beforeEach(async function() {
  MinkeApp._network = { network: {} };
  const app = await (new MinkeApp().createFromJSON({ vars: '' }));
  app._globalId = '1FB44E7C-7E63-4739-A1F6-569220469E8B';
  await app.createJS();
  this.app = app;
});

afterEach(function() {
  delete this.app;
});

}
