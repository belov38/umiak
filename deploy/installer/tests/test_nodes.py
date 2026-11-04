import pytest

from fake_pve import FakeRunner, is_mutation
from test_day2 import FakeUi
from umiak_installer import nodes, state
from umiak_installer.pve import InstallerError


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
