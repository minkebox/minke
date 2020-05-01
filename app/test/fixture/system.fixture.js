const sinon = require('sinon');

module.exports = function() {
  global.DEBUG = false;
  global.SYSTEM = true;
  global.Root = {
    emit: sinon.fake()
  };
}
