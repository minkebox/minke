const assert = require('assert');
const FS = require('fs');

require('./fixture/system.fixture')();
require('./fixture/skeletons.fixture')();


describe('Skeletons', async function() {

  describe('Builtins', function() {

    function validate(name) {
      it(`validate ${name}`, function() {
        let skel = null;
        eval(`skel=${FS.readFileSync(`./skeletons/builtin/${name}`, { encoding: 'utf8' })}`);
        assert.ok(skel);
        assert.ok(skel.uuid, 'missing uuid');
        assert.ok(skel.actions, 'missing actions');
        assert.ok(skel.properties, 'missing properties');
        assert.ok(skel.image || skel.images, 'missing image');
      });
    }

    FS.readdirSync('./skeletons/builtin').forEach(skeleton => {
      validate(skeleton);
    });

  });

  describe('catalog', function() {

    it('catalog isnt empty', function() {
      assert.notEqual(this.skeletons.catalog().length, 0);
    });

  });

  describe('loadSkeleton', function() {

    it('load builtin', function() {
      assert.ok(this.skeletons.loadSkeleton('FE8D1F85-0F18-4FFB-BA7F-FD91D2354CFE'));
    });

    it('load skeleton which doesnt exist', function() {
      assert.ok(!this.skeletons.loadSkeleton('FE8D1F85-0000-0000-0000-FD91D2354CFE'));
    });

  });


});
