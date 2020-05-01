const proxyquire = require('proxyquire');
const sinon = require('sinon');

// Force production config
proxyquire('../../Config', {
  './Config-Development': null,
  '@global': true
});

module.exports = function() {
  global.DEBUG = false;
  global.SYSTEM = true;
  global.Root = {
    emit: sinon.fake()
  };
}
