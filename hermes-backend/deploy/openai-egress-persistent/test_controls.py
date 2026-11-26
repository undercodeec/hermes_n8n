import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import firewall
import orchestrator
import proxy


class FirewallTests(unittest.TestCase):
    def test_invalid_interface_never_calls_nft(self):
        with mock.patch.object(firewall, "nft") as run:
            with self.assertRaises(ValueError):
                firewall.install('br"; delete table inet x')
            run.assert_not_called()

    def test_install_is_atomic_and_defaults_to_drop(self):
        with mock.patch.object(firewall, "nft") as run:
            firewall.install("br-openai")
        rules = run.call_args.args[0]
        self.assertIn("create table inet", rules)
        self.assertIn('iifname "br-openai" drop', rules)
        self.assertIn('oifname "br-openai" drop', rules)
        self.assertIn("ip daddr @destinations tcp dport 443", rules)
        self.assertNotIn("ip6 daddr", rules)
        self.assertEqual(run.call_count, 1)

    def test_dns_rejects_mixed_private_results(self):
        results = [(None, None, None, None, (ip, 443)) for ip in ("8.8.8.8", "127.0.0.1")]
        with mock.patch.object(firewall.socket, "getaddrinfo", return_value=results):
            with self.assertRaises(ValueError):
                firewall.resolve()

    def test_nft_failure_does_not_publish_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "lease.json")
            with mock.patch.object(firewall, "resolve", return_value=["8.8.8.8"]), mock.patch.object(firewall, "nft", side_effect=OSError("failure")):
                with self.assertRaises(OSError):
                    firewall.refresh(path)
            self.assertFalse(os.path.exists(path))

    def test_refresh_uses_timed_atomic_set_and_shorter_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "lease.json")
            with mock.patch.object(firewall, "resolve", return_value=["8.8.8.8"]), mock.patch.object(firewall, "nft") as run, mock.patch.object(firewall.time, "monotonic", return_value=100):
                firewall.refresh(path)
            with open(path, encoding="utf-8") as source:
                data = json.load(source)
            self.assertEqual(data["expires_monotonic"], 140)
            self.assertIn("timeout 45s", run.call_args.args[0])
            self.assertIn("flush set", run.call_args.args[0])


class ProxyTests(unittest.TestCase):
    def check_lease(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "lease.json")
            with open(path, "w", encoding="utf-8") as out:
                json.dump(data, out)
            with mock.patch.object(proxy.time, "monotonic", return_value=100):
                return proxy.destinations(path)

    def test_valid_lease(self):
        self.assertEqual(self.check_lease({"addresses": ["8.8.8.8"], "expires_monotonic": 120}), ["8.8.8.8"])

    def test_expired_or_overlong_lease_rejected(self):
        for expires in (99, 146):
            with self.subTest(expires=expires), self.assertRaises(ValueError):
                self.check_lease({"addresses": ["8.8.8.8"], "expires_monotonic": expires})

    def test_private_and_ipv6_addresses_rejected(self):
        for ip in ("127.0.0.1", "::1"):
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                self.check_lease({"addresses": [ip], "expires_monotonic": 120})

    def test_header_deadline_is_absolute_even_with_trickled_bytes(self):
        client = mock.Mock()
        client.recv.return_value = b"a"
        with mock.patch.object(proxy.time, "monotonic", side_effect=[0, 1, 2, 9, 10]):
            with self.assertRaises(TimeoutError):
                proxy.read_header(client)
        self.assertEqual(client.settimeout.call_args_list, [mock.call(9), mock.call(1)])

    def test_header_preserves_pipelined_tls(self):
        client = mock.Mock()
        client.recv.return_value = b"CONNECT api.openai.com:443 HTTP/1.1\r\nX: y\r\n\r\nTLS"
        header, pending = proxy.read_header(client)
        self.assertTrue(header.endswith(b"X: y"))
        self.assertEqual(pending, b"TLS")

    def test_oversize_header_rejected(self):
        client = mock.Mock()
        client.recv.side_effect = [b"x" * 4096, b"x" * 4096, b"x"]
        with self.assertRaises(ValueError):
            proxy.read_header(client)

    def test_auth_requires_one_matching_header(self):
        expected = b"Basic dTpw"
        request = b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
        self.assertTrue(proxy.authorized(request + b"Proxy-Authorization: Basic dTpw", expected))
        for suffix in (b"Host: x", b"Proxy-Authorization: Basic bad", b"Proxy-Authorization: Basic dTpw\r\nProxy-Authorization: Basic dTpw", b"Proxy-Authorization: Basic dTpw\r\n folded"):
            self.assertFalse(proxy.authorized(request + suffix, expected))

    def test_auth_file_missing_or_invalid_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "secret")
            with self.assertRaises(OSError):
                proxy.load_auth(path)
            for content in (b"user:", b":password", b"user:password\n", b"a:b:c", b"x" * 4097):
                with open(path, "wb") as out:
                    out.write(content)
                with self.subTest(content=content[:20]), self.assertRaises(ValueError):
                    proxy.load_auth(path)
            with open(path, "wb") as out:
                out.write(b"u:p")
            self.assertEqual(proxy.load_auth(path), b"Basic dTpw")

    def test_saturated_server_does_not_spawn_handler(self):
        server = proxy.Server(("127.0.0.1", 0), proxy.Handler, b"Basic dTpw")
        self.addCleanup(server.server_close)
        server.slots = mock.Mock()
        server.slots.acquire.return_value = False
        with mock.patch.object(server, "shutdown_request") as shutdown, mock.patch.object(proxy.socketserver.ThreadingTCPServer, "process_request") as spawn:
            server.process_request(mock.sentinel.request, mock.sentinel.address)
        shutdown.assert_called_once_with(mock.sentinel.request)
        spawn.assert_not_called()


class OrchestrationTests(unittest.TestCase):
    IMAGE = "registry.example/proxy@sha256:" + "a" * 64

    def test_bootstrap_refuses_uncertain_network_before_installing_guard(self):
        with mock.patch.object(orchestrator, "check_network", side_effect=ValueError("occupied")) as check, \
             mock.patch.object(orchestrator.firewall, "install") as install:
            with self.assertRaises(ValueError):
                orchestrator.bootstrap()
        check.assert_called_once_with(require_empty=True)
        install.assert_not_called()

    def test_bootstrap_network_must_be_confirmed_empty(self):
        network = {"Driver": "bridge", "Internal": False,
                   "Options": {"com.docker.network.bridge.name": orchestrator.BRIDGE},
                   "Containers": {}}
        with mock.patch.object(orchestrator, "command", side_effect=lambda *args: json.dumps([network])):
            orchestrator.check_network(require_empty=True)
            network["Containers"] = {"foreign": {"Name": "other"}}
            with self.assertRaises(ValueError):
                orchestrator.check_network(require_empty=True)
            del network["Containers"]
            with self.assertRaises(ValueError):
                orchestrator.check_network(require_empty=True)

    def test_units_do_not_modify_docker_or_autostart_on_boot(self):
        units = Path(__file__).parent / "systemd"
        self.assertFalse(any(units.glob("docker.service.d/*.conf")))
        self.assertFalse(any(units.glob("docker.socket.d/*.conf")))
        guard = (units / "openai-egress-guard.service").read_text(encoding="utf-8")
        proxy_unit = (units / "openai-egress-proxy.service").read_text(encoding="utf-8")
        self.assertNotIn("Before=docker", guard)
        self.assertNotIn("WantedBy=", guard)
        self.assertNotIn("WantedBy=", proxy_unit)
        self.assertIn("Requires=openai-egress-guard.service docker.service", proxy_unit)
        self.assertIn("BindsTo=docker.service", proxy_unit)
        self.assertNotIn("PartOf=docker.service", proxy_unit)

    def test_prepare_order_and_no_restart_policy(self):
        calls = []
        with mock.patch.object(orchestrator, "verify_guard", side_effect=lambda: calls.append("verify")), \
             mock.patch.object(orchestrator, "check_network", side_effect=lambda: calls.append("network")), \
             mock.patch.object(orchestrator, "remove_owned", side_effect=lambda: calls.append("remove")), \
             mock.patch.object(orchestrator, "check_running", side_effect=lambda: calls.append("running")), \
             mock.patch.object(orchestrator.firewall, "refresh", side_effect=lambda _: calls.append("refresh")), \
             mock.patch.object(orchestrator, "command", side_effect=lambda *args: calls.append(args)):
            orchestrator.prepare(self.IMAGE)
        self.assertEqual(calls[:3], ["verify", "network", "remove"])
        create = calls[3]
        self.assertEqual(create[:2], ("docker", "create"))
        self.assertEqual(create[create.index("--restart") + 1], "no")
        self.assertEqual(calls[4:], ["verify", "refresh", "verify", ("docker", "start", orchestrator.NAME), "running"])

    def test_uncertain_steps_never_start_proxy(self):
        for failed in ("verify_guard", "check_network", "remove_owned", "refresh", "create"):
            with self.subTest(failed=failed):
                commands = []
                def run(*args):
                    commands.append(args)
                    if failed == "create" and args[:2] == ("docker", "create"):
                        raise OSError("create failed")
                def fail_if(name):
                    if failed == name:
                        raise ValueError(name)
                with mock.patch.object(orchestrator, "verify_guard", side_effect=lambda: fail_if("verify_guard")), \
                     mock.patch.object(orchestrator, "check_network", side_effect=lambda: fail_if("check_network")), \
                     mock.patch.object(orchestrator, "remove_owned", side_effect=lambda: fail_if("remove_owned")), \
                     mock.patch.object(orchestrator.firewall, "refresh", side_effect=lambda _: fail_if("refresh")), \
                     mock.patch.object(orchestrator, "command", side_effect=run):
                    with self.assertRaises((ValueError, OSError)):
                        orchestrator.prepare(self.IMAGE)
                self.assertNotIn(("docker", "start", orchestrator.NAME), commands)

    def test_manager_replacement_stops_and_removes_owned_container(self):
        with mock.patch.object(orchestrator, "inspect_owned", side_effect=[True, False]), mock.patch.object(orchestrator, "command") as run:
            orchestrator.remove_owned()
        self.assertEqual(run.call_args_list, [mock.call("docker", "stop", "--time", "10", orchestrator.NAME), mock.call("docker", "rm", orchestrator.NAME)])

    def test_guard_disappearance_during_prepare_never_starts(self):
        for failed_check in (2, 3):
            calls = []
            count = [0]
            def verify():
                count[0] += 1
                if count[0] == failed_check:
                    raise ValueError("guard disappeared")
            with self.subTest(failed_check=failed_check), \
                 mock.patch.object(orchestrator, "verify_guard", side_effect=verify), \
                 mock.patch.object(orchestrator, "check_network"), \
                 mock.patch.object(orchestrator, "remove_owned"), \
                 mock.patch.object(orchestrator.firewall, "refresh"), \
                 mock.patch.object(orchestrator, "command", side_effect=lambda *args: calls.append(args)):
                with self.assertRaises(ValueError):
                    orchestrator.prepare(self.IMAGE)
            self.assertNotIn(("docker", "start", orchestrator.NAME), calls)

    def test_container_with_restart_or_extra_network_is_rejected(self):
        info = {"Config": {"Labels": {orchestrator.OWNER: "1"}},
                "State": {"Running": True},
                "HostConfig": {"RestartPolicy": {"Name": "no"}, "NetworkMode": orchestrator.NETWORK},
                "NetworkSettings": {"Networks": {orchestrator.NETWORK: {}}}}
        with mock.patch.object(orchestrator, "command", side_effect=lambda *args: json.dumps([info])):
            orchestrator.check_running()
            info["HostConfig"]["RestartPolicy"]["Name"] = "always"
            with self.assertRaises(ValueError):
                orchestrator.check_running()
            info["HostConfig"]["RestartPolicy"]["Name"] = "no"
            info["NetworkSettings"]["Networks"]["other"] = {}
            with self.assertRaises(ValueError):
                orchestrator.check_running()

    def test_unowned_container_is_not_removed(self):
        info = json.dumps([{"Config": {"Labels": {}}}])
        with mock.patch.object(orchestrator, "command", side_effect=[orchestrator.NAME, info]) as run:
            with self.assertRaises(ValueError):
                orchestrator.remove_owned()
        self.assertEqual(run.call_count, 2)

    def test_daemon_error_is_not_absence(self):
        with mock.patch.object(orchestrator, "command", side_effect=OSError("daemon unavailable")):
            with self.assertRaises(OSError):
                orchestrator.inspect_owned()

    def test_mutable_image_rejected_before_docker(self):
        with mock.patch.object(orchestrator, "command") as run:
            with self.assertRaises(ValueError):
                orchestrator.prepare("proxy:latest")
            run.assert_not_called()

    def test_guard_structure_ignores_only_dynamic_members_and_handles(self):
        objects = [{"table": {"name": "x", "handle": 1}}, {"set": {"name": "s", "elem": ["8.8.8.8"]}}]
        objects += [{"chain": {"name": str(i)}} for i in range(3)]
        objects += [{"rule": {"expr": [i], "handle": i}} for i in range(6)]
        first = orchestrator.structure(json.dumps({"nftables": objects}))
        objects[1]["set"]["elem"] = []
        self.assertEqual(first, orchestrator.structure(json.dumps({"nftables": objects})))
        objects[-1]["rule"]["expr"] = [99]
        self.assertNotEqual(first, orchestrator.structure(json.dumps({"nftables": objects})))
        objects.append({"unknown": {}})
        with self.assertRaises(ValueError):
            orchestrator.structure(json.dumps({"nftables": objects}))


if __name__ == "__main__":
    unittest.main()
