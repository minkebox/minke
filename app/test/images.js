const assert = require('assert');

require('./fixture/system.fixture')();

beforeEach(function() {
  this.images = require('../Images');
});
afterEach(function() {
  delete this.images;
});

describe('Images', async function() {

  describe('withTag', function() {

    it('simple name', function() {
      assert.equal(this.images.withTag('ubuntu'), 'ubuntu:latest');
    });

    it('long name', function() {
      assert.equal(this.images.withTag('registry.somewhere.com/application'), 'registry.somewhere.com/application:latest');
    });

    it('explicit tag', function() {
      assert.equal(this.images.withTag('ubuntu:edge'), 'ubuntu:edge');
    });

    describe('Minke specific', function() {

      it('minke latest', function() {
        assert.equal(this.images.withTag('registry.minkebox.net/minkebox/minke'), 'registry.minkebox.net/minkebox/minke:latest');
      });

      it('minke-helper latest', function() {
        assert.equal(this.images.withTag('registry.minkebox.net/minkebox/minke-helper'), 'registry.minkebox.net/minkebox/minke-helper:latest');
      });

    });

  });

});
