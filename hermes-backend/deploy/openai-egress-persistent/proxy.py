#!/usr/bin/env python3
"""Minimal CONNECT-only proxy. The client, not this proxy, validates TLS."""
import base64
import hmac
import ipaddress
import json
import selectors
import socket
import socketserver
import threading
import time

LEASE = "/run/openai-lease/lease.json"
HOST = b"api.openai.com:443"
MAX_HEADER = 8192
HEADER_TIMEOUT = 10
IDLE_TIMEOUT = 300
AUTH_FILE = "/run/secrets/openai-proxy-auth"


def load_auth(path=AUTH_FILE):
    # Exact username:password bytes, no trailing newline; never log the value.
    with open(path, "rb") as source:
        secret = source.read(4097)
    if len(secret) > 4096 or secret.count(b":") != 1 or not all(33 <= c <= 126 for c in secret):
        raise ValueError("invalid proxy credential file")
    username, password = secret.split(b":")
    if not username or not password:
        raise ValueError("invalid proxy credential file")
    return b"Basic " + base64.b64encode(secret)


def read_header(client):
    deadline = time.monotonic() + HEADER_TIMEOUT
    data = b""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("header deadline exceeded")
        client.settimeout(remaining)
        chunk = client.recv(min(4096, MAX_HEADER + 1 - len(data)))
        if time.monotonic() >= deadline:
            raise TimeoutError("header deadline exceeded")
        if not chunk:
            raise ValueError("incomplete header")
        data += chunk
        end = data.find(b"\r\n\r\n")
        if end >= 0:
            if end + 4 > MAX_HEADER:
                raise ValueError("header too large")
            return data[:end], data[end + 4:]
        if len(data) > MAX_HEADER:
            raise ValueError("header too large")


def authorized(header, expected):
    lines = header.split(b"\r\n")
    values = []
    for line in lines[1:]:
        if b":" not in line or line[:1] in (b" ", b"\t"):
            return False
        name, value = line.split(b":", 1)
        if name.lower() == b"proxy-authorization":
            values.append(value.strip(b" \t"))
    return len(values) == 1 and hmac.compare_digest(values[0], expected)


def destinations(path=LEASE):
    with open(path, encoding="utf-8") as source:
        data = json.load(source)
    expiry = data["expires_monotonic"]
    if not isinstance(expiry, (int, float)) or not time.monotonic() < expiry <= time.monotonic() + 45:
        raise ValueError("expired or invalid lease")
    addresses = data["addresses"]
    if not isinstance(addresses, list) or not 0 < len(addresses) <= 32:
        raise ValueError("invalid addresses")
    if any(not isinstance(ip, str) or not ipaddress.IPv4Address(ip).is_global for ip in addresses):
        raise ValueError("invalid address")
    return addresses


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.serve()
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            pass

    def serve(self):
        client = self.request
        header, pending = read_header(client)
        parts = header.split(b"\r\n", 1)[0].split(b" ")
        if len(parts) != 3 or parts[0] != b"CONNECT" or parts[1].lower() != HOST or parts[2] not in (b"HTTP/1.0", b"HTTP/1.1"):
            client.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
        if not authorized(header, self.server.auth):
            client.sendall(b'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="openai"\r\nConnection: close\r\n\r\n')
            return
        upstream = None
        for ip in destinations():
            try:
                upstream = socket.create_connection((ip, 443), timeout=5)
                break
            except OSError:
                continue
        if upstream is None:
            return
        with upstream, selectors.DefaultSelector() as selector:
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            client.settimeout(IDLE_TIMEOUT)
            upstream.settimeout(IDLE_TIMEOUT)
            if pending:
                upstream.sendall(pending)
            selector.register(client, selectors.EVENT_READ, upstream)
            selector.register(upstream, selectors.EVENT_READ, client)
            while True:
                events = selector.select(IDLE_TIMEOUT)
                if not events:
                    return
                for key, _ in events:
                    data = key.fileobj.recv(65536)
                    if not data:
                        return
                    key.data.sendall(data)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, auth):
        self.auth = auth
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


if __name__ == "__main__":
    with Server(("0.0.0.0", 3128), Handler, load_auth()) as server:
        server.serve_forever()
