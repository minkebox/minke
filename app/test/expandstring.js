const assert = require('assert');

require('./fixture/system.fixture')();

describe('Expand', async function() {

  describe('MinkeApp.expandString', async function() {

    require('./fixture/minkeapp.fixture')();

    it('Empty string', async function() {
      const str = await this.app.expandString('');
      assert.equal(str, '');
    });

    it('Simple string', async function() {
      const str = await this.app.expandString('hello');
      assert.equal(str, 'hello');
    });

    it('Quoted string', async function() {
      const str = await this.app.expandString('"hello"');
      assert.equal(str, '"hello"');
    });

    it('{{__MACADDRESS}}', async function() {
      const str = await this.app.expandString('{{__MACADDRESS}}');
      assert.equal(str, '5A:92:20:46:9E:8B');
    });

    it('abc{{__MACADDRESS}}def', async function() {
      const str = await this.app.expandString('abc{{__MACADDRESS}}def');
      assert.equal(str, 'abc5A:92:20:46:9E:8Bdef');
    });

    describe('Newlines', function() {

      it('abc\\ndef', async function() {
        const str = await this.app.expandString('abc\ndef');
        assert.equal(str, 'abc\ndef');
      });

      it('{{__MACADDRESS}}\\n', async function() {
        const str = await this.app.expandString('{{__MACADDRESS}}\n');
        assert.equal(str, '5A:92:20:46:9E:8B\n');
      });

      it('{{"\\n"}}', async function() {
        const str = await this.app.expandString('{{"\n"}}');
        assert.equal(str, '\n');
      });

    });

    describe('Expression', function() {

      it('{{1 + 2}}', async function() {
        const str = await this.app.expandString('{{1 + 2}}');
        assert.equal(str, 3);
      });

      it('{{"1" + "2"}}', async function() {
        const str = await this.app.expandString('{{"1" + "2"}}');
        assert.equal(str, '12');
      });

    })

  });

});
