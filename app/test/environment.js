const assert = require('assert');

describe('Environment', async function() {

  require('./fixture/system.fixture')();

  describe('MinkeApp.expandEnvironment', async function() {

    require('./fixture/minkeapp.fixture')();

    it('Empty environment', async function() {
      const env = await this.app.expandEnvironment({
      });
      assert.equal(Object.keys(env).length, 0);
    });

    it('Single, null enviroment entry', async function() {
      const env = await this.app.expandEnvironment({
        thing: {}
      });
      assert.equal(env.thing.value, '');
    });

    it('Single, default enviroment entry', async function() {
      const env = await this.app.expandEnvironment({
        thing: { value: '"thang"' }
      });
      assert.equal(env.thing.value, 'thang');
    });

    it('System property: __MACADDRESS', async function() {
      const env = await this.app.expandEnvironment({
        thing: { value: '__MACADDRESS' }
      });
      assert.equal(env.thing.value, '5A:92:20:46:9E:8B');
    });

    describe('Strings', function() {

      it('"abc" + __MACADDRESS + "def"', async function() {
        const env = await this.app.expandEnvironment({
          thing: { value: '"abc" + __MACADDRESS + "def"' }
        });
        assert.equal(env.thing.value, 'abc5A:92:20:46:9E:8Bdef');
      });

    });

    describe('Numbers', function() {

      it('1 + 2', async function() {
        const env = await this.app.expandEnvironment({
          thing: { value: '1 + 2' }
        });
        assert.equal(env.thing.value, 3);
      });

    });

    describe('Bools', function() {

      it('true && true', async function() {
        const env = await this.app.expandEnvironment({
          thing: { value: 'true && true' }
        });
        assert.equal(env.thing.value, true);
      });

    });

  });

});
