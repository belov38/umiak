import pytest

from fake_pve import FakeRunner, is_mutation
from test_day2 import FakeUi
from umiak_installer import nodes, state
from umiak_installer.pve import CommandError, InstallerError


class Console:
    def __init__(self, blockers=None):
        self.calls = []
        self.blockers = blockers or []

    def call(self, op, **data):
        self.calls.append((op, data))
        if op == "capabilities":
            return {"multiNode": True}
        if op == "list":
            return {
                "nodes": [
                    {"nodeId": "a", "name": "pve", "storage": "local-lvm", "ramCapMb": 4096},
                    {"nodeId": "b", "name": "pve2", "storage": "local-lvm", "ramCapMb": 4096},
                ]
            }
        if op == "retire":
            return {"ok": not self.blockers, "blockers": self.blockers}
        return {"ok": True}


class Host:
    def __init__(self):
        self.calls = []

    def call(self, node, op, **data):
        self.calls.append((node, op, data))
        return {}


def installed():
    return state.InstallState(
        version=1,
        ct_id=590,
        ct_ip="192.168.68.50",
        node="pve",
        release="0.1.0",
        tailnet_host="umiak.ts.net",
        phase="complete",
        answers={
            "storage": "local-lvm",
            "vmid_min": 500,
            "vmid_max": 589,
            "tpl_min": 600,
            "tpl_max": 699,
            "guest_dns": "1.1.1.1",
        },
    )


def test_remove_refuses_db_blockers_before_any_host_changes(tmp_path):
    runner = FakeRunner(tmp_path)
    cp, host = Console([{"kind": "snapshot", "id": "saved"}]), Host()
    with pytest.raises(InstallerError, match="snapshot.*saved"):
        nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=host)
    assert host.calls == []
    assert [op for op, _ in cp.calls] == ["capabilities", "list", "retire"]


def test_remove_marks_retired_before_root_cleanup_and_keeps_shared_key(tmp_path):
    runner = FakeRunner(tmp_path)
    cp, host = Console(), Host()
    nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=host)
    assert cp.calls[-1][0] == "retire"
    assert host.calls[0][0:2] == ("pve2", "remove")
    assert host.calls[0][2]["remaining_nodes"] == ["pve"]
    assert not any(is_mutation(a) for a in runner.commands)


def test_node_host_refuses_other_host_identity_before_mutation(tmp_path):
    from umiak_installer.node_host import dispatch

    runner = FakeRunner(tmp_path)
    with pytest.raises(InstallerError, match="identity"):
        dispatch(runner, {"op": "inspect", "node": "pve2", "storage": "local-lvm"})
    assert not runner.commands


def test_root_transport_keeps_strict_pinning_and_never_sends_private_key(tmp_path):
    runner = FakeRunner(tmp_path)
    sent = []
    runner.run = lambda argv, input=None: sent.append((argv, input)) or "{}"
    nodes.HostConsole(runner).call("pve2", "inspect", storage="local-lvm")
    argv, payload = sent[0]
    assert argv[:2] == ["ssh", "-T"]
    assert "StrictHostKeyChecking=yes" in argv
    assert "root@pve2" in argv
    assert "PRIVATE KEY" not in payload


def test_add_cancellation_does_not_install_or_hand_off_secrets(tmp_path):
    runner = FakeRunner(tmp_path)
    secrets = runner.path("/var/lib/umiak-installer/secrets")
    secrets.mkdir(parents=True)
    (secrets / "known_hosts").write_text("192.168.68.10,pve ssh-ed25519 old\n")
    host = Host()
    host.call = lambda node, op, **data: {"checks": [], "sshHost": "192.168.68.11", "hostKey": "ssh-ed25519 new"}
    with pytest.raises(InstallerError, match="Cancelled"):
        nodes.add_node(runner, installed(), None, "pve2", ui=FakeUi(), console=Console(), host=host)
    assert not any(is_mutation(a) for a in runner.commands)
    assert (secrets / "known_hosts").read_text() == "192.168.68.10,pve ssh-ed25519 old\n"


def test_add_never_rotates_a_changed_host_pin(tmp_path):
    runner = FakeRunner(tmp_path)
    secrets = runner.path("/var/lib/umiak-installer/secrets")
    secrets.mkdir(parents=True)
    (secrets / "known_hosts").write_text("192.168.68.11,pve2 ssh-ed25519 old\n")
    host = Host()
    host.call = lambda node, op, **data: {"checks": [], "sshHost": "192.168.68.11", "hostKey": "ssh-ed25519 new"}
    with pytest.raises(InstallerError, match="host key changed"):
        nodes.add_node(runner, installed(), None, "pve2", ui=FakeUi(yes=True), console=Console(), host=host)
    assert not any(is_mutation(a) for a in runner.commands)


def test_removing_sandbox_role_does_not_count_the_control_plane_ct_as_a_sandbox(tmp_path):
    import json

    from umiak_installer.node_host import _unused

    runner = FakeRunner(tmp_path)
    runner.objects["/nodes/pve/lxc"] = [{"vmid": 590}]
    runner.objects["/nodes/pve/lxc/590/config"] = {"tags": "umiak", "net0": "bridge=vmbr0"}
    original = runner.run
    runner.run = lambda argv, input=None: json.dumps({"report": []}) if argv[0] == "lvs" else original(argv, input)
    _unused(runner, "pve", 590)


def test_bad_agent_checksum_refuses_before_prerequisite_fixes(tmp_path):
    from umiak_installer.node_host import dispatch

    runner = FakeRunner(tmp_path, dnsmasq=False, ip_forward="0")
    with pytest.raises(InstallerError, match="checksum"):
        dispatch(
            runner,
            {
                "op": "prepare",
                "node": "pve",
                "config": {"storage": "local-lvm", "gateway_ip": "192.168.68.50"},
                "binary": "YmFk",
                "sha256": "0" * 64,
                "public_key": "bad",
            },
        )
    assert not any(is_mutation(a) for a in runner.commands)


def test_added_node_prepares_idempotently_without_new_token_or_private_key(tmp_path):
    import base64
    import copy
    import hashlib

    from test_prepare_host import AGENT, config
    from umiak_installer import prepare_host
    from umiak_installer.node_host import dispatch

    primary = FakeRunner(tmp_path / "primary")
    out = tmp_path / "secrets"
    result = prepare_host.prepare(primary, config(), out)
    target = FakeRunner(tmp_path / "target", hostname="pve2")
    target.objects = copy.deepcopy(primary.objects)
    target.users, target.roles, target.tokens, target.acls = copy.deepcopy(
        (primary.users, primary.roles, primary.tokens, primary.acls)
    )
    target.objects["/access/acl"] = target.acls
    common = prepare_host.FORCED_COMMAND + result.public_key + "\n"
    target.path(prepare_host.AUTHORIZED_KEYS).write_text(common)
    request = {
        "op": "prepare",
        "node": "pve2",
        "config": {"storage": "local-lvm", "gateway_ip": "192.168.68.90"},
        "members": ["pve", "pve2"],
        "binary": base64.b64encode(AGENT).decode(),
        "sha256": hashlib.sha256(AGENT).hexdigest(),
        "public_key": result.public_key,
    }
    first = dispatch(target, request)
    assert dispatch(target, request) == first
    assert first["sshHost"] == "192.168.68.11"
    assert target.token_counter == 0
    assert not any(a[0] == "ssh-keygen" for a in target.commands)
    assert target.path(prepare_host.AUTHORIZED_KEYS).read_text() == common
    assert not target.path("/var/lib/umiak-installer/secrets/umiak-node_ed25519").exists()


def test_storage_mismatch_is_rejected_before_extracting_or_preparing_host(tmp_path):
    runner = FakeRunner(tmp_path)
    secrets = runner.path("/var/lib/umiak-installer/secrets")
    secrets.mkdir(parents=True)
    (secrets / "known_hosts").write_text("")
    cp, host = Console(), Host()
    host.call = lambda node, op, **data: {
        "checks": [],
        "sshHost": "192.168.68.11",
        "hostKey": "ssh-ed25519 new",
        "mediaStorage": "local",
    }
    original = cp.call

    def reject(op, **data):
        if op == "prepare-add":
            raise InstallerError("Changing local storage requires storage migration")
        return original(op, **data)

    cp.call = reject
    with pytest.raises(InstallerError, match="storage migration"):
        nodes.add_node(runner, installed(), None, "pve2", storage="other", ui=FakeUi(yes=True), console=cp, host=host)
    assert not any(is_mutation(a) for a in runner.commands)


def test_local_sdn_verification_requires_bridge_gateway_and_tunnel_reachability(tmp_path):
    import json

    from test_prepare_host import config
    from umiak_installer import node_host, prepare_host

    runner = FakeRunner(tmp_path)
    runner.objects[prepare_host.SUBNET] = {
        "gateway": "10.88.0.1",
        "snat": 1,
        "dhcp-range": "start-address=10.88.0.100,end-address=10.88.0.250",
    }
    node_host._verify_local_sdn(runner, config())
    assert ["systemctl", "is-active", "dnsmasq@umiak.service"] in runner.commands
    assert any(a[0] == "python3" and a[-1] == config().gateway_ip for a in runner.commands)
    original = runner.run
    runner.run = lambda argv, input=None: json.dumps([]) if argv[:2] == ["ip", "-j"] else original(argv, input)
    with pytest.raises(InstallerError, match="gateway.*missing"):
        node_host._verify_local_sdn(runner, config())


def test_missing_cluster_vnet_fails_post_prepare_verification_before_agent_install(tmp_path):
    import base64
    import copy
    import hashlib

    from test_prepare_host import AGENT, config
    from umiak_installer import node_host, prepare_host

    primary = FakeRunner(tmp_path / "primary")
    result = prepare_host.prepare(primary, config(), tmp_path / "secrets")
    target = FakeRunner(tmp_path / "target", hostname="pve2")
    target.objects = copy.deepcopy(primary.objects)
    target.users, target.roles, target.tokens, target.acls = copy.deepcopy(
        (primary.users, primary.roles, primary.tokens, primary.acls)
    )
    target.objects["/access/acl"] = target.acls
    del target.objects["/cluster/sdn/vnets/umiak0"]
    with pytest.raises(CommandError, match="pvesh failed"):
        node_host.dispatch(
            target,
            {
                "op": "prepare",
                "node": "pve2",
                "config": {"storage": "local-lvm", "gateway_ip": "192.168.68.90"},
                "members": ["pve", "pve2"],
                "binary": base64.b64encode(AGENT).decode(),
                "sha256": hashlib.sha256(AGENT).hexdigest(),
                "public_key": result.public_key,
            },
        )
    assert not target.path(prepare_host.NODE_BINARY).exists()
    assert not target.path(prepare_host.NODE_CONFIG).exists()


def test_sdn_config_without_local_snat_rule_refuses_activation(tmp_path):

    from test_prepare_host import config
    from umiak_installer import node_host, prepare_host

    runner = FakeRunner(tmp_path)
    runner.objects[prepare_host.SUBNET] = {"gateway": "10.88.0.1", "snat": 1, "dhcp-range": "range"}
    original = runner.run
    runner.run = lambda argv, input=None: "" if argv[0] == "iptables" else original(argv, input)
    with pytest.raises(InstallerError, match="SNAT rule is missing"):
        node_host._verify_local_sdn(runner, config())


def test_zone_membership_appends_and_removes_one_comma_separated_node(tmp_path):
    from umiak_installer.node_host import _zone

    runner = FakeRunner(tmp_path)
    runner.objects["/cluster/sdn/zones/umiak"] = {"type": "simple", "dhcp": "dnsmasq", "nodes": "pve,pve3"}
    _zone(runner, ["pve", "pve2"])
    assert runner.objects["/cluster/sdn/zones/umiak"]["nodes"] == "pve,pve2,pve3"
    _zone(runner, ["pve"], remove="pve2")
    assert runner.objects["/cluster/sdn/zones/umiak"]["nodes"] == "pve,pve3"
    runner.objects["/cluster/sdn/zones/umiak"]["nodes"] = "pve2"
    _zone(runner, [], remove="pve2")
    assert runner.objects["/cluster/sdn/zones/umiak"]["nodes"] == "pve2"
    assert all(a[-1] for a in runner.commands if a[:3] == ["pvesh", "set", "/cluster/sdn/zones/umiak"])


def test_remote_helper_does_not_pass_a_private_umask_to_pve_sdn(tmp_path):
    import json
    import subprocess
    import sys

    output = tmp_path / "dhcp.conf"
    sources = {
        "__init__.py": "",
        "pve.py": "class Runner: pass\n",
        "node_host.py": (
            "from pathlib import Path\n"
            "def dispatch(runner, request):\n"
            " p=Path(request['output']);p.write_text('dhcp')\n"
            " return {'mode':p.stat().st_mode & 0o777}\n"
        ),
    }
    result = subprocess.run(
        [sys.executable, "-c", nodes.BOOTSTRAP],
        input=json.dumps({"sources": sources, "request": {"output": str(output)}}),
        text=True, capture_output=True, check=True, umask=0o077,
    )
    assert json.loads(result.stdout)["mode"] == 0o644
