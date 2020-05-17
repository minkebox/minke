const DGram = require('dgram');
const Net = require('net');
const _native = require('./build/Release/native');

module.exports = {

  getTCPSocketOnInterface: function(interfaceName, address, port) {
    const fd = _native.BindTCPIFace(interfaceName, address, port);
    return new Net.Socket({ fd: fd });
  },

  getUDPSocketOnInterface: function(interfaceName, address, port) {
    const udp = DGram.createSocket('udp4');
    const fd = _native.BindUDPIFace(interfaceName, address, port);
    setImmediate(() => {
      udp.bind({ fd: fd });
    });
    return udp;
  }

};
