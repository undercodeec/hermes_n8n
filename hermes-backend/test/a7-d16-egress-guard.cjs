'use strict';

// Each Jest worker applies this before importing application modules.
// The only sockets these tests need are the two loopback containers.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const host =
    typeof options === 'object' && options !== null
      ? (options.host ?? options.hostname ?? 'localhost')
      : typeof options === 'number'
        ? 'localhost'
        : undefined;
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`A7_D16_EGRESS_BLOCKED: ${host}`);
  }
  return originalConnect.apply(this, args);
};
