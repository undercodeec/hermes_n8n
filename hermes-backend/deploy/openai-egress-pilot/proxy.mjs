// LOCAL TEST FIXTURE ONLY: raw TCP tunnel; TLS remains end-to-end at the client.
import net from 'node:net';

export function startProxy({ upstreamPort, listenPort = 0 }) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535 ||
      !Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535 ||
      (listenPort !== 0 && listenPort === upstreamPort)) {
    throw new Error('invalid or looping port');
  }
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    // Literal loopback only: no resolver, environment proxy or external fallback.
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort, allowHalfOpen: true });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    const abort = () => { client.destroy(); upstream.destroy(); };
    client.on('error', abort);
    upstream.on('error', abort);
    // pipe propagates each EOF independently; do not destroy on normal close,
    // which could discard data still flushing in the opposite direction.
    client.pipe(upstream).pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      // Port 0 can select the upstream port if it is no longer bound.
      if (server.address().port === upstreamPort) {
        server.close(() => reject(new Error('looping port')));
        return;
      }
      resolve({ port: server.address().port, close: () => new Promise((done, fail) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => error ? fail(error) : done());
      }) });
    });
  });
}
