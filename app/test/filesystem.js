const assert = require('assert');

describe('Filesystem', async function() {

  require('./fixture/system.fixture')();
  require('./fixture/minkeapp.fixture')();
  require('./fixture/filesystem.fixture')();

  describe('makeFile', function() {

    it('simple file', async function() {
      await this.fs._makeFile(this.app, {
        target: '/a/file/somewhere',
        src: '/a/file/somewhere',
        value: 'hello',
        mode: 0o666
      });
      assert.ok(this.fs.mocks.mkdirSync.called);
      assert.ok(this.fs.mocks.writeFileSync.called);
      assert.equal(this.fs.mocks.writeFileSync.firstCall.args[1], 'hello');
    });

    it('substitute file contents', async function() {
      this.app._vars['/a/file/somewhere'] = { type: 'String', value: 'goodbye' };
      await this.fs._makeFile(this.app, {
        target: '/a/file/somewhere',
        src: '/a/file/somewhere',
        value: 'hello',
        mode: 0o666
      });
      assert.ok(this.fs.mocks.mkdirSync.called);
      assert.ok(this.fs.mocks.writeFileSync.called);
      assert.equal(this.fs.mocks.writeFileSync.firstCall.args[1], 'goodbye');
    });

    it('substitute file default contents', async function() {
      this.app._vars['/a/file/somewhere'] = { type: 'String', defaultValue: 'goodbye' };
      await this.fs._makeFile(this.app, {
        target: '/a/file/somewhere',
        src: '/a/file/somewhere',
        value: 'hello',
        mode: 0o666
      });
      assert.ok(this.fs.mocks.mkdirSync.called);
      assert.ok(this.fs.mocks.writeFileSync.called);
      assert.equal(this.fs.mocks.writeFileSync.firstCall.args[1], 'goodbye');
    });

    it('substitute file contents with variable', async function() {
      this.app._vars.stuff = { type: 'String', value: '-' };
      this.app._vars['/a/file/somewhere'] = { type: 'String', defaultValue: 'good{{stuff}}bye' };
      await this.app.createJS();
      await this.fs._makeFile(this.app, {
        target: '/a/file/somewhere',
        src: '/a/file/somewhere',
        value: 'hello',
        mode: 0o666
      });
      assert.ok(this.fs.mocks.mkdirSync.called);
      assert.ok(this.fs.mocks.writeFileSync.called);
      assert.equal(this.fs.mocks.writeFileSync.firstCall.args[1], 'good-bye');
    });

  });

});
