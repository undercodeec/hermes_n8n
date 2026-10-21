import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import axios from 'axios';

/** A process-local transport barrier; the CLI installs it before dry-run work. */
export function installF2OfflineNetworkDeny(): () => void {
  const blocked = () => {
    throw new Error('F2_OFFLINE_NETWORK_DENIED');
  };
  const original = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
    axiosPost: axios.post.bind(axios),
    fetch: globalThis.fetch,
  };
  http.request = blocked;
  http.get = blocked;
  https.request = blocked;
  https.get = blocked;
  net.connect = blocked;
  net.createConnection = blocked;
  tls.connect = blocked;
  axios.post = blocked;
  globalThis.fetch = blocked;
  return () => {
    http.request = original.httpRequest;
    http.get = original.httpGet;
    https.request = original.httpsRequest;
    https.get = original.httpsGet;
    net.connect = original.netConnect;
    net.createConnection = original.netCreateConnection;
    tls.connect = original.tlsConnect;
    axios.post = original.axiosPost;
    globalThis.fetch = original.fetch;
  };
}
