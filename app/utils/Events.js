const EventEmitter = require('events');

const Events = function() {
  this._emitter = new EventEmitter();
  this._eventState = {};
}

Events.prototype = {

  on: function(event, listener) {
    this._emitter.on(event, listener);
    if (this._emitter.listenerCount(event) === 1) {
      this._emitter.emit(`${event}.start`);
    }
  },

  off: function(event, listener) {
    this._emitter.off(event, listener);
    if (this._emitter.listenerCount(event) === 0) {
      this._emitter.emit(`${event}.stop`);
    }
  },

  emit: function(event, data) {
    this._eventState[event] = data;
    this._emitter.emit(event, data);
  }

};

module.exports = Events;
