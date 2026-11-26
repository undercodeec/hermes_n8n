#!/usr/bin/env python3
"""Controlled systemd lifecycle; see README for mandatory host assumptions."""
import argparse
import json
import os
import re
import signal
import subprocess
import tempfile
import time

import firewall

RUNTIME = "/run/openai-egress"
FINGERPRINT = RUNTIME + "/guard.json"
LEASE = RUNTIME + "/lease.json"
SECRET = "/etc/openai-egress/proxy-auth"
NAME = "openai-egress-proxy"
OWNER = "org.hermes.openai-egress"
BRIDGE = "br-openai"
NETWORK = "openai-egress"
stopping = False


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=20).stdout


def structure(raw):
    objects = json.loads(raw)["nftables"]
    result = []
    for item in objects:
        if len(item) != 1:
            raise ValueError("unexpected nft object")
        kind, value = next(iter(item.items()))
        if kind == "metainfo":
            continue
        if kind not in ("table", "set", "chain", "rule") or not isinstance(value, dict):
            raise ValueError("unexpected nft object")
        value = dict(value)
        value.pop("handle", None)
        if kind == "set":
            value.pop("elem", None)  # Timed members legitimately change.
        result.append({kind: value})
    counts = {kind: sum(kind in entry for entry in result) for kind in ("table", "set", "chain", "rule")}
    if counts != {"table": 1, "set": 1, "chain": 3, "rule": 6}:
        raise ValueError("unexpected guard structure")
    return result


def current_guard():
    return structure(command("nft", "-j", "list", "table", "inet", firewall.TABLE))


def bootstrap():
    # Never replace an existing table; a partially completed boot needs operator recovery.
    # Do not install bridge-wide rules over already-attached workloads.
    check_network(require_empty=True)
    os.makedirs(RUNTIME, mode=0o755, exist_ok=True)
    stat = os.stat(RUNTIME)
    if stat.st_uid != 0 or stat.st_mode & 0o022 or stat.st_mode & 0o005 != 0o005:
        raise ValueError("runtime directory must be root-owned, readable and searchable, not group/world writable")
    firewall.install(BRIDGE)
    snapshot = current_guard()
    fd, tmp = tempfile.mkstemp(dir=RUNTIME, prefix=".guard-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(snapshot, out, sort_keys=True)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, FINGERPRINT)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def verify_guard():
    with open(FINGERPRINT, encoding="utf-8") as source:
        expected = json.load(source)
    if current_guard() != expected:
        raise ValueError("guard changed")


def inspect_owned():
    # List first: a daemon/permission error is not treated as absence.
    names = command("docker", "container", "ls", "-a", "--format", "{{.Names}}").splitlines()
    if NAME not in names:
        return False
    info = json.loads(command("docker", "inspect", NAME))
    if len(info) != 1 or info[0]["Config"].get("Labels", {}).get(OWNER) != "1":
        raise ValueError("container name is occupied by an unowned container")
    return True


def remove_owned():
    if inspect_owned():
        command("docker", "stop", "--time", "10", NAME)
        command("docker", "rm", NAME)
        if inspect_owned():
            raise ValueError("container still exists")


def check_network(require_empty=False):
    networks = json.loads(command("docker", "network", "inspect", NETWORK))
    if len(networks) != 1:
        raise ValueError("unexpected network count")
    network = networks[0]
    if (network.get("Driver") != "bridge" or network.get("Internal") is not False
            or network.get("Options", {}).get("com.docker.network.bridge.name") != BRIDGE):
        raise ValueError("unexpected network configuration")
    if require_empty and network.get("Containers") != {}:
        raise ValueError("dedicated network is not demonstrably empty")


def check_running():
    info = json.loads(command("docker", "inspect", NAME))
    if len(info) != 1:
        raise ValueError("unexpected container count")
    container = info[0]
    if (container["Config"].get("Labels", {}).get(OWNER) != "1"
            or container["State"].get("Running") is not True
            or container["HostConfig"]["RestartPolicy"].get("Name") != "no"
            or container["HostConfig"].get("NetworkMode") != NETWORK
            or set(container["NetworkSettings"]["Networks"]) != {NETWORK}):
        raise ValueError("proxy stopped or configuration changed")


def prepare(image):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}", image):
        raise ValueError("image must be specified by sha256 digest")
    verify_guard()
    check_network()
    remove_owned()
    # Container does not exist or is stopped until after all validation succeeds.
    command("docker", "create", "--name", NAME, "--label", OWNER + "=1",
            "--restart", "no", "--network", NETWORK, "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "65534:65534",
            "--mount", f"type=bind,src={RUNTIME},dst=/run/openai-lease,readonly",
            "--mount", f"type=bind,src={SECRET},dst=/run/secrets/openai-proxy-auth,readonly",
            image)
    verify_guard()
    firewall.refresh(LEASE)
    verify_guard()
    if stopping:
        raise RuntimeError("shutdown requested before proxy start")
    command("docker", "start", NAME)
    check_running()


def stop_signal(_signum, _frame):
    global stopping
    stopping = True


def supervise(image):
    global stopping
    stopping = False
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    try:
        prepare(image)
        while not stopping:
            time.sleep(firewall.INTERVAL)
            if stopping:
                break
            verify_guard()
            check_running()
            firewall.refresh(LEASE)
    finally:
        # Never remove firewall here, even when Docker cannot be contacted.
        if inspect_owned():
            command("docker", "stop", "--time", "10", NAME)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("bootstrap", "supervise"))
    parser.add_argument("--image")
    args = parser.parse_args()
    if args.action == "bootstrap":
        bootstrap()
    else:
        supervise(args.image or "")


if __name__ == "__main__":
    main()
