const assert = require('assert');

describe('Variables', async function() {

  require('./fixture/system.fixture')();

  function commonTest() {

    it('setVariable simple', function() {
      this.app.setVariable('key', 'value');
    });

    it('expandVariable simple', async function() {
      assert.equal(await this.app.expandVariable('key'), null);
    });

    it('expandString simple', async function() {
      assert.equal(await this.app.expandString('testing'), 'testing');
    });

    it('variables are not auto-created', async function() {
      this.app.setVariable('key', 'value');
      assert.equal(await this.app.expandVariable('key'), null);
    });

  }

  describe('MinkeSetup', function() {
    require('./fixture/minkesetup.fixture')();
    commonTest();
  });

  describe('MinkeApp', function() {
    require('./fixture/minkeapp.fixture')();

    commonTest();

    describe('Type conversions', function() {

      it('expandString: string to number', async function() {
        this.app._vars.reallyanumber = { type: 'String', value: '10' };
        assert.strictEqual(await this.app.expandVariable('reallyanumber'), 10);
      });

      it('expandString: number to number', async function() {
        this.app._vars.reallyanumber = { type: 'String', value: 10 };
        assert.strictEqual(await this.app.expandVariable('reallyanumber'), 10);
      });

      it('expandString: string to bool (true)', async function() {
        this.app._vars.reallyanumber = { type: 'String', value: 'true' };
        assert.strictEqual(await this.app.expandVariable('reallyanumber'), true);
      });

      it('expandString: string to bool (false)', async function() {
        this.app._vars.reallyanumber = { type: 'String', value: 'false' };
        assert.strictEqual(await this.app.expandVariable('reallyanumber'), false);
      });

    });

    describe('Default values', function() {

      it('expandString with simple default', async function() {
        this.app._vars.astring = { type: 'String', defaultValue: 'a string' };
        assert.equal(await this.app.expandVariable('astring'), 'a string');
      });

      it('expandString with variable default', async function() {
        this.app._vars.anotherstring = { type: 'String', defaultValue: '{{astring}}' };
        this.app._vars.astring = { type: 'String', defaultValue: 'a string' };
        await this.app.createJS();
        assert.equal(await this.app.expandVariable('anotherstring'), 'a string');
      });

    });

    describe('Patterns', function() {

      beforeEach(function() {
        this.app._vars.testing = { type: 'Array', value: [ [ '1', '2' ], [ '3', '4' ] ] };
      });

      it('default pattern', async function() {
        assert.equal(await this.app.expandVariable('testing'), '1\n3');
      })

      it('simple pattern', async function() {
        this.app._vars.testing.encoding = { pattern: '{{V[0]}}{{V[1]}}', join: '' };
        assert.equal(await this.app.expandVariable('testing'), '1234');
      });

      it('reverse pattern', async function() {
        this.app._vars.testing.encoding = { pattern: '{{V[1]}}{{V[0]}}', join: '' };
        assert.equal(await this.app.expandVariable('testing'), '2143');
      });

      it('simple JS pattern with numbers', async function() {
        this.app._vars.testing.encoding = { pattern: '{{V[0]+V[1]}}', join: '' };
        assert.equal(await this.app.expandVariable('testing'), '37');
      });

      it('pattern with newline', async function() {
        this.app._vars.testing.encoding = { pattern: '{{V[0]}}{{V[1]}}\n', join: '' };
        assert.equal(await this.app.expandVariable('testing'), '12\n34\n');
      });

      it('pattern with newline join', async function() {
        this.app._vars.testing.encoding = { pattern: '{{V[0]}}{{V[1]}}', join: '\n' };
        assert.equal(await this.app.expandVariable('testing'), '12\n34');
      });

      it('pattern with word join', async function() {
        this.app._vars.testing.encoding = { pattern: '{{V[0]}}{{V[1]}}', join: '-hello-' };
        assert.equal(await this.app.expandVariable('testing'), '12-hello-34');
      });

      it('pattern with JS function', async function() {
        this.app._vars.testing.encoding = { pattern: '{{parseInt(V[0]*10+V[1],16)}}', join: '\n' };
        assert.equal(await this.app.expandVariable('testing'), '18\n52');
      });

    });

  });


});
