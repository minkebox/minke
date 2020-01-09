try {
  module.exports = require('./Config-Development');
}
catch (_) {
  module.exports = require('./Config-Production');
}
