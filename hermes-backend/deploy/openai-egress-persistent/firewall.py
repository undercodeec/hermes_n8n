#!/usr/bin/env python3
"""Host-side nftables lease manager. Linux only; run with root privileges."""
import argparse
import ipaddress
import json
import os
import re
import socket
import subprocess
import tempfile
import time

TABLE = "openai_egress_guard"
HOST = "api.openai.com"
LEASE = 45
INTERVAL = 15
MAX_ADDRESSES = 32


def bridge_name(value):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", value):
        raise ValueError("invalid interface name")
    return value


def resolve():
    addresses = sorted({item[4][0] for item in socket.getaddrinfo(
        HOST, 443, socket.AF_INET, socket.SOCK_STREAM)})
    if not addresses or len(addresses) > MAX_ADDRESSES:
        raise ValueError("empty or oversized DNS result")
    if any(not ipaddress.IPv4Address(ip).is_global for ip in addresses):
        raise ValueError("non-global address in DNS result")
    return addresses


def nft(script):
    subprocess.run(["nft", "-f", "-"], input=script, text=True, check=True, timeout=15)


def install(bridge):
    b = bridge_name(bridge)
    # A single nft transaction: an existing table makes creation fail.
    nft(f'''create table inet {TABLE}
add set inet {TABLE} destinations {{ type ipv4_addr; flags timeout; }}
add chain inet {TABLE} input {{ type filter hook input priority -150; policy accept; }}
add chain inet {TABLE} output {{ type filter hook output priority -150; policy accept; }}
add chain inet {TABLE} forward {{ type filter hook forward priority -150; policy accept; }}
add rule inet {TABLE} input iifname "{b}" drop
add rule inet {TABLE} output oifname "{b}" drop
add rule inet {TABLE} forward iifname "{b}" oifname != "{b}" ip daddr @destinations tcp dport 443 return
add rule inet {TABLE} forward oifname "{b}" iifname != "{b}" ip saddr @destinations tcp sport 443 ct state established return
add rule inet {TABLE} forward iifname "{b}" drop
add rule inet {TABLE} forward oifname "{b}" drop
''')


def refresh(path):
    addresses = resolve()
    # Start the application lease before DNS result publication and before nft;
    # it therefore cannot outlive the firewall lease even if the clock pauses.
    expires = time.monotonic() + LEASE - 5
    elements = ", ".join(f"{ip} timeout {LEASE}s" for ip in addresses)
    nft(f"flush set inet {TABLE} destinations\nadd element inet {TABLE} destinations {{ {elements} }}\n")
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".openai-lease-", dir=directory)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump({"addresses": addresses, "expires_monotonic": expires}, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bridge", help="dedicated Docker bridge interface")
    parser.add_argument("lease", help="lease file in a host directory mounted read-only into proxy")
    args = parser.parse_args()
    install(args.bridge)
    while True:
        try:
            refresh(args.lease)
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            print(f"refresh failed; existing leases expire: {exc}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
