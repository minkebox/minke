const assert = require('assert');

require('./fixture/system.fixture')();

const FS = require('fs');
const Path = require('path');

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

});
