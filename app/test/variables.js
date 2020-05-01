const assert = require('assert');

require('./fixture/system.fixture')();

describe('Variables', async function() {

  function test() {

    it('setVariable simple', function() {
      this.app.setVariable('key', 'value');
    });

    it('expandVariable simple', async function() {
      assert.equal(await this.app.expandVariable('key'), null);
    });

    it('expandString simple', async function() {
      assert.equal(await this.app.expandString('testing'), 'testing');
    });

  }

  describe('MinkeApp', function() {
    require('./fixture/minkeapp.fixture')();
    test();
  });

  describe('MinkeSetup', function() {
    require('./fixture/minkesetup.fixture')();
    test();
  });
});
