const UDP = require('dgram');
 const _native = require('./build/Release/native');

module.exports = {

  bindDGramSocketToInterface: function(socket, interfaceName, address, port) {
    socket.bind(port, address, () => {
      _native.BindIFaceSocket(socket._handle.fd, interfaceName);
    });
  }

};
