const sinon = require('sinon');
const mock = require('mock-require');

// Force production config
mock('../../Config-Development', require('../../Config-Production'));

module.exports = function() {
  global.DEBUG = false;
  global.SYSTEM = true;
  global.Root = {
    emit: sinon.fake()
  };
}
