const assert = require('assert');

describe('Restart', async function() {

  require('./fixture/system.fixture')();

  describe('MinkeSetup', function() {
    require('./fixture/minkesetup.fixture')();

    it('Default reason', function() {
      assert.equal(this.MinkeSetup.restartReason(), 'restart');
    });

    it('Change reason', function() {
      assert.equal(this.MinkeSetup.restartReason('exit'), 'restart');
      assert.equal(this.MinkeSetup.restartReason(), 'exit');
    });

  });

});
