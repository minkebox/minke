/*
 * Original code from https://github.com/commonshost/playdoh
 * Bug fixes by me.
 */

const { createSocket } = require('dgram');
const { toBuffer } = require('base64url');
const { decode } = require('dns-packet');
const { randomFill } = require('crypto');
const { promisify } = require('util');
const URL = require('url');

const {
  BadRequest,
  MethodNotAllowed,
  PayloadTooLarge,
  InternalServerError,
  BadGateway,
  GatewayTimeout,
  HTTPVersionNotSupported
} = require('http-errors');

const {
  constants: {
    HTTP2_HEADER_ACCEPT,
    HTTP2_HEADER_CACHE_CONTROL,
    HTTP2_HEADER_CONTENT_LENGTH,
    HTTP2_HEADER_CONTENT_TYPE,
    HTTP2_METHOD_GET,
    HTTP2_METHOD_POST
  }
} = require('http2');

const dohMediaType = 'application/dns-message';
const dohMaximumMessageLength = 65535;
const dohMinimumHttpVersionMajor = 2;

function smallestTtl (min, { ttl }) {
  return ttl < min ? ttl : min;
}

function readUntil (stream, chunks, limit) {
  return new Promise((resolve, reject) => {
    let totalLength = 0
    stream.on('data', (chunk) => {
      totalLength += chunk.length;
      if (totalLength > dohMaximumMessageLength) {
        reject(new RangeError());
      } else if (chunk.length > 0) {
        chunks.push(chunk);
        if (totalLength === limit) {
          resolve();
        }
      }
    });
    stream.on('error', (err) => {
      reject(err);
    });
    stream.once('end', () => {
      resolve();
    })
  });
}

module.exports.playdoh =
function playdoh ({
  protocol = 'udp4',
  localAddress = '',
  resolverAddress = '',
  resolverPort = 53,
  timeout = 10000,
  serverName = 'localhost',
  path = '/'
} = {}) {
  if (resolverAddress === '' || resolverAddress === 'localhost') {
    resolverAddress = protocol === 'udp6' ? '::1' : '127.0.0.1';
  }
  return async function playdoh (request, response, next) {
    if (request.headers[HTTP2_HEADER_ACCEPT] !== dohMediaType) {
      return next();
    }
    if (request.httpVersionMajor < dohMinimumHttpVersionMajor) {
      return next(new HTTPVersionNotSupported());
    }
    const dnsMessage = [];
    const url = new URL(request.url, `https://${serverName}/`);
    if (url.pathname !== path) {
      return next();
    }
    switch (request.method) {
      case HTTP2_METHOD_GET:
        const dns = url.searchParams.get('dns');
        if (!dns) {
          return next(new BadRequest());
        }
        let decoded;
        try {
          decoded = toBuffer(dns);
        } catch (error) {
          return next(new BadRequest());
        }
        if (decoded.length > dohMaximumMessageLength) {
          return next(new PayloadTooLarge());
        }
        dnsMessage.push(decoded);
        break;
      case HTTP2_METHOD_POST:
        try {
          await readUntil(request, dnsMessage, parseInt(request.headers['content-length'], 10) || dohMaximumMessageLength);
        } catch (error) {
          return next(new PayloadTooLarge());
        }
        break;
      default:
        return next(new MethodNotAllowed());
    }
    if (dnsMessage.length === 0 || dnsMessage[0].length < 2) {
      return next(new BadRequest());
    }

    const requestDnsId = dnsMessage[0].readUInt16BE(0);
    await promisify(randomFill)(dnsMessage[0], 0, 2);
    const nonceDnsId = dnsMessage[0].readUInt16BE(0);

    let socket;
    try {
      socket = createSocket(protocol);
      socket.bind({ address: localAddress, exclusive: true });
    } catch (error) {
      return next(new InternalServerError());
    }

    socket.once('error', () => next(new BadGateway()));

    socket.once('listening', () => {
      const timer = setTimeout(() => {
        socket.close();
        next(new GatewayTimeout());
      }, timeout);
      socket.once('close', () => clearTimeout(timer));
      socket.send(dnsMessage, resolverPort, resolverAddress);
      dnsMessage.length = 0;
    })

    socket.on('message', (message, { port, address }) => {
      if (
        message.length < 2 ||
        message.readUInt16BE(0) !== nonceDnsId ||
        address !== resolverAddress ||
        port !== resolverPort
      ) {
        return;
      }
      message.writeUInt16BE(requestDnsId, 0)
      if (request.method === HTTP2_METHOD_GET) {
        let answers;
        try {
          ({ answers } = decode(message));
        } catch (error) {
          return next(new BadGateway());
        }
        const ttl = answers.reduce(smallestTtl, Infinity);
        if (Number.isFinite(ttl)) {
          response.setHeader(HTTP2_HEADER_CACHE_CONTROL, `max-age=${ttl}`);
        }
      }
      response.setHeader(HTTP2_HEADER_CONTENT_LENGTH, message.length);
      response.setHeader(HTTP2_HEADER_CONTENT_TYPE, dohMediaType);
      response.end(message);
      socket.close();
    });
  }
}