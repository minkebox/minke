const assert = require('assert');

describe('Expand', async function() {

  require('./fixture/system.fixture')();

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

    describe('Functions', function() {

      it('{{__RANDOMHEX(16)}}', async function() {
        const str = await this.app.expandString('{{__RANDOMHEX(16)}}');
        assert.equal(str.length, 16);
      });

      it('{{__RANDOMPORTS(1)}}', async function() {
        const str = await this.app.expandString('{{__RANDOMPORTS(1)}}');
        assert.notEqual(str, 0);
        assert.equal(parseInt(str), str);
      });
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
