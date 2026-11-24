const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const tls = require('node:tls');

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', '/tmp/key.pem', '-out', '/tmp/cert.pem', '-days', '1',
  '-subj', '/CN=api.synthetic.test', '-addext', 'subjectAltName=DNS:api.synthetic.test'],
{ stdio: 'ignore' });
tls.createServer({ key: fs.readFileSync('/tmp/key.pem'), cert: fs.readFileSync('/tmp/cert.pem') }, socket => {
  socket.end('synthetic-upstream-ok\n');
}).listen(8443, '0.0.0.0', () => console.log('synthetic upstream listening'));
