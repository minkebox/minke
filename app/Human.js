const HTTPS = require('https');
const Config = require('./Config');

const VERIFY_URL = `${Config.CAPTCH_VERIFY}`;


const Human = {

  start: function(globalId, humanRef) {
    this._id = globalId;
    this._ref = humanRef;
    Root.on('human.verify', this._verify);
    Root.on('system.captcha.token', this._update);
  },

  _update: function(evt) {
    if (evt.token) {
      switch (evt.token) {
        case 'cancel':
          Human._ref.value = 'no';
          break;
        case 'maybe':
          Human._ref.value = 'maybe';
          break;
        default:
          HTTPS.get(`${VERIFY_URL}?key=${Human._id}&token=${evt.token}`, res => {
            if (res.statusCode === 200) {
              Human._ref.value = 'yes';
            }
            else {
              Human._ref.value = 'no';
            }
            Root.emit('human.verified', { human: Human._ref.value });
          });
          break;
        }
    }
  },

  stop: function() {
    Root.off('system.captcha.token', this._update);
    Root.off('human.verify', this._verify);
  },

  _verify: function(evt) {
    if (evt.force || Human._ref.value === 'unknown') {
      Root.emit('system.captcha');
    }
  },

  isVerified: function() {
    return this._ref.value === 'yes';
  }

};

module.exports = Human;
