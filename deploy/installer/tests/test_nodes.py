import pytest

from fake_pve import FakeRunner, is_mutation
from test_day2 import FakeUi
from umiak_installer import nodes, state
from umiak_installer.pve import CommandError, InstallerError

EMPTY_PLAN = {"node": "pve2", "sandboxes": [], "machines": [], "snapshots": [], "templates": [], "blockers": []}
TEMPLATE = {"buildId": "tb1", "slug": "linux", "version": "1.2.0", "vmid": 20001, "status": "active"}
SANDBOX = {"id": "0190-sbx", "slug": "quiet-otter", "name": "agent box", "state": "ready", "vmids": [10007]}
SNAPSHOT = {"id": "0190-snp", "name": "before-upgrade", "kind": "saved", "state": "ready"}


class Console:
    def __init__(self, blockers=None, plans=None, retired=False, template_error=None):
        self.calls = []
        self.blockers = blockers or []
        # removal-plan answers in order; the last one repeats.
        self.plans = list(plans or [EMPTY_PLAN])
        self.retired = retired
        self.template_error = template_error

    def call(self, op, **data):
        self.calls.append((op, data))
        if op == "capabilities":
            return {"multiNode": True}
        if op == "list":
            node = {"nodeId": "b", "name": "pve2", "storage": "local-lvm", "ramCapMb": 4096}
            return {
                "nodes": [{"nodeId": "a", "name": "pve", "storage": "local-lvm", "ramCapMb": 4096}]
                + ([] if self.retired else [node]),
                "retiredNodes": [node] if self.retired else [],
            }
        if op in ("removal-plan", "purge"):
            return self.plans.pop(0) if len(self.plans) > 1 else self.plans[0]
        if op == "retire-template" and self.template_error:
            raise CommandError(["pct"], 1, stderr=self.template_error)
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


def real_ui(answers, *, interactive=True, yes=False):
    from umiak_installer.main import Ui

    said = []
    ui = Ui(interactive=interactive, yes=yes, input_fn=lambda prompt: answers.pop(0), out=said.append)
    return ui, said


def plan(**parts):
    return dict(EMPTY_PLAN, **parts)


def test_remove_refuses_retire_blockers_in_plain_language_before_host_changes(tmp_path):
    runner = FakeRunner(tmp_path)
    leftover = plan(blockers=[{"kind": "disk", "id": "d1", "message": "Disk local-lvm:vm-1-disk-0 is still recorded"}])
    cp, host = Console([{"kind": "disk", "id": "d1"}], plans=[EMPTY_PLAN, EMPTY_PLAN, leftover]), Host()
    with pytest.raises(InstallerError, match="still blocked.*Disk local-lvm:vm-1-disk-0 is still recorded"):
        nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=host)
    assert host.calls == []


def test_remove_marks_retired_before_root_cleanup_and_keeps_shared_key(tmp_path):
    runner = FakeRunner(tmp_path)
    cp, host = Console(), Host()
    nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=host)
    assert cp.calls[-1][0] == "retire"
    assert host.calls[0][0:2] == ("pve2", "remove")
    assert host.calls[0][2]["remaining_nodes"] == ["pve"]
    assert not any(is_mutation(a) for a in runner.commands)


def test_remove_templates_only_node_lists_and_retires_its_templates_with_one_confirmation(tmp_path):
    runner = FakeRunner(tmp_path)
    cp, host = Console(plans=[plan(templates=[TEMPLATE]), plan(templates=[TEMPLATE])]), Host()
    ui, said = real_ui(["y"])
    nodes.remove_node(runner, installed(), "pve2", ui=ui, console=cp, host=host)
    text = "\n".join(said)
    assert "linux 1.2.0 (VMID 20001)" in text
    assert "Other sandbox nodes keep their own templates" in text
    assert "control-plane CT" in text
    ops = [op for op, _ in cp.calls]
    assert ops == ["capabilities", "list", "removal-plan", "purge", "retire-template", "retire"]
    assert cp.calls[4][1] == {"nodeId": "b", "buildId": "tb1"}
    assert host.calls[0][0:2] == ("pve2", "remove")


def test_remove_with_sandboxes_needs_the_typed_node_name_even_with_yes(tmp_path):
    runner = FakeRunner(tmp_path)
    busy = plan(sandboxes=[SANDBOX], snapshots=[SNAPSHOT], templates=[TEMPLATE])
    cp, host = Console(plans=[busy]), Host()
    ui, said = real_ui(["pve"], yes=True)
    with pytest.raises(InstallerError, match="Cancelled"):
        nodes.remove_node(runner, installed(), "pve2", ui=ui, console=cp, host=host)
    text = "\n".join(said)
    assert 'quiet-otter "agent box" (ready, VMID 10007)' in text
    assert "before-upgrade (saved, ready)" in text
    assert "purge" not in [op for op, _ in cp.calls]
    assert host.calls == []


def test_remove_deletes_sandboxes_with_progress_then_templates(tmp_path):
    runner = FakeRunner(tmp_path)
    busy = plan(sandboxes=[SANDBOX], snapshots=[SNAPSHOT], templates=[TEMPLATE])
    half = plan(snapshots=[dict(SNAPSHOT, state="deleting")], templates=[TEMPLATE])
    cp, host = Console(plans=[busy, busy, half, plan(templates=[TEMPLATE])]), Host()
    ui, said = real_ui(["y", "pve2"])
    nodes.remove_node(runner, installed(), "pve2", ui=ui, console=cp, host=host, sleep=lambda s: None)
    ops = [op for op, _ in cp.calls]
    assert ops.index("purge") < ops.index("retire-template") < ops.index("retire")
    assert dict(cp.calls)["purge"] == {"nodeId": "b", "confirmed": ["0190-sbx", "0190-snp"]}
    progress = [line for line in said if "left" in line]
    assert progress == ["  Deleting on pve2: 1 sandbox, 1 snapshot left", "  Deleting on pve2: 1 snapshot left"]
    assert any("Deleting template linux 1.2.0 (VMID 20001)" in line for line in said)


def test_remove_non_interactive_needs_delete_sandboxes(tmp_path):
    from umiak_installer.main import UsageError

    runner = FakeRunner(tmp_path)
    cp = Console(plans=[plan(sandboxes=[SANDBOX])])
    ui, _ = real_ui([], interactive=False, yes=True)
    with pytest.raises(UsageError, match="--delete-sandboxes"):
        nodes.remove_node(runner, installed(), "pve2", ui=ui, console=cp, host=Host())
    assert "purge" not in [op for op, _ in cp.calls]
    cp = Console(plans=[plan(sandboxes=[SANDBOX]), EMPTY_PLAN])
    nodes.remove_node(runner, installed(), "pve2", ui=ui, console=cp, host=Host(), delete_sandboxes=True,
                      sleep=lambda s: None)
    assert [op for op, _ in cp.calls][-1] == "retire"


def test_remove_reports_plan_blockers_before_any_change(tmp_path):
    runner = FakeRunner(tmp_path)
    message = "A template build windows is running on pve2 (job j1); wait until it finishes, then retry"
    cp, host = Console(plans=[plan(templates=[TEMPLATE], blockers=[{"kind": "build", "id": "j1", "message": message}])]), Host()
    with pytest.raises(InstallerError, match="template build windows is running on pve2"):
        nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=host)
    assert [op for op, _ in cp.calls] == ["capabilities", "list", "removal-plan"]
    assert host.calls == []


def test_remove_stops_on_a_stalled_purge_and_says_what_is_left(tmp_path):
    runner = FakeRunner(tmp_path)
    stuck = plan(sandboxes=[dict(SANDBOX, state="deleting")])
    cp, host = Console(plans=[stuck]), Host()
    now = [0.0]

    def sleep(seconds):
        now[0] += seconds

    with pytest.raises(InstallerError, match=r"no progress.*quiet-otter \(deleting\).*rerun"):
        nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(answers=["y", "pve2"]), console=cp, host=host,
                          sleep=sleep, clock=lambda: now[0])
    assert "retire" not in [op for op, _ in cp.calls]
    assert host.calls == []


def test_remove_stops_when_new_sandboxes_appear_while_waiting(tmp_path):
    runner = FakeRunner(tmp_path)
    busy = plan(sandboxes=[SANDBOX])
    newcomer = dict(SANDBOX, id="0190-new", slug="late-heron", state="creating")
    cp, host = Console(plans=[busy, busy, plan(sandboxes=[dict(SANDBOX, state="deleting"), newcomer])]), Host()
    with pytest.raises(InstallerError, match="sandbox late-heron appeared on pve2.*Rerun the removal"):
        nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(answers=["y", "pve2"]), console=cp, host=host,
                          sleep=lambda s: None)
    assert "retire" not in [op for op, _ in cp.calls]


def test_remove_explains_a_failed_template_delete(tmp_path):
    runner = FakeRunner(tmp_path)
    cp = Console(plans=[plan(templates=[TEMPLATE])], template_error="node: warning\nTemplate deletion task: VM is locked\n")
    with pytest.raises(InstallerError, match=r"linux 1.2.0 \(VMID 20001\) on pve2: Template deletion task: VM is locked"):
        nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=Host())


def test_remove_retry_of_a_retired_node_finishes_host_cleanup(tmp_path):
    runner = FakeRunner(tmp_path)
    cp, host = Console(retired=True), Host()
    nodes.remove_node(runner, installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=host)
    assert [op for op, _ in cp.calls] == ["capabilities", "list", "retire"]
    assert host.calls[0][0:2] == ("pve2", "remove")


def test_node_host_refuses_other_host_identity_before_mutation(tmp_path):
    from umiak_installer.node_host import dispatch

    runner = FakeRunner(tmp_path)
    with pytest.raises(InstallerError, match="identity"):
        dispatch(runner, {"op": "inspect", "node": "pve2", "storage": "local-lvm"})
    assert not runner.commands


@pytest.mark.parametrize("per_node", [True, False])
def test_root_transport_uses_pve_cluster_ip_alias_and_known_hosts(tmp_path, per_node):
    runner = FakeRunner(tmp_path)
    known = "/etc/pve/nodes/pve2/ssh_known_hosts" if per_node else "/etc/pve/priv/known_hosts"
    pin = runner.path(known)
    pin.parent.mkdir(parents=True, exist_ok=True)
    pin.write_text("pve2 ssh-rsa cluster-key\n")
    original, sent = runner.run, []

    def run(argv, input=None):
        if argv[0] == "ssh":
            sent.append((argv, input))
            return "{}"
        return original(argv, input)

    runner.run = run
    nodes.HostConsole(runner).call("pve2", "inspect", storage="local-lvm")
    argv, payload = sent[0]
    assert argv[:2] == ["ssh", "-T"]
    assert "StrictHostKeyChecking=yes" in argv
    assert "BatchMode=yes" in argv
    assert "HostKeyAlias=pve2" in argv
    assert "UserKnownHostsFile=" + known in argv
    assert "GlobalKnownHostsFile=none" in argv
    assert "root@192.168.68.11" in argv
    assert "PRIVATE KEY" not in payload


def test_root_transport_missing_cluster_trust_refuses_with_repair_guidance(tmp_path):
    runner = FakeRunner(tmp_path)
    with pytest.raises(InstallerError, match="pvecm updatecerts.*pve2"):
        nodes.HostConsole(runner).call("pve2", "inspect")
    assert not any(a[0] == "ssh" for a in runner.commands)


def test_root_transport_bad_cluster_pin_keeps_strict_checking_and_explains_repair(tmp_path):
    runner = FakeRunner(tmp_path)
    pin = runner.path("/etc/pve/priv/known_hosts")
    pin.write_text("pve2 ssh-rsa stale-key\n")
    original = runner.run

    def run(argv, input=None):
        if argv[0] == "ssh":
            runner.commands.append(argv)
            raise CommandError(argv, 255, stderr="Host key verification failed")
        return original(argv, input)

    runner.run = run
    with pytest.raises(InstallerError, match="pvecm updatecerts.*pve2"):
        nodes.HostConsole(runner).call("pve2", "inspect")
    assert "StrictHostKeyChecking=yes" in runner.commands[-1]


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
    legacy = target.path(prepare_host.DNSMASQ_CONF_DIR)
    legacy.mkdir(parents=True, mode=0o700)
    conf = legacy / "umiak0.conf"
    conf.write_text("dhcp-range=10.88.0.100,10.88.0.250")
    conf.chmod(0o600)
    first = dispatch(target, request)
    assert legacy.stat().st_mode & 0o777 == 0o755
    assert conf.stat().st_mode & 0o777 == 0o644
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


def test_removal_refuses_orphan_template_disks_without_vm_rows(tmp_path):
    import json

    from umiak_installer.node_host import _unused

    runner = FakeRunner(tmp_path)
    runner.objects["/nodes/pve/lxc"] = []
    original = runner.run
    runner.run = lambda argv, input=None: (
        json.dumps({"report": [{"lv": [{"lv_name": "base-601-disk-0", "lv_tags": "umiak-tpl"}]}]})
        if argv[0] == "lvs" else original(argv, input)
    )
    with pytest.raises(InstallerError, match="base-601-disk-0"):
        _unused(runner, "pve", 590)


def test_root_transport_ignores_macos_archive_metadata(tmp_path, monkeypatch):
    import json

    runner = FakeRunner(tmp_path / "host")
    pin = runner.path("/etc/pve/priv/known_hosts")
    pin.write_text("pve2 ssh-rsa cluster-key\n")
    source = tmp_path / "sources"
    source.mkdir()
    (source / "nodes.py").write_text("# source\n")
    (source / "._nodes.py").write_bytes(b"\x00\x05\xa3\xff")
    monkeypatch.setattr(nodes, "__file__", str(source / "nodes.py"))
    original = runner.run
    sent = []

    def run(argv, input=None):
        if argv[0] == "ssh":
            sent.append(json.loads(input))
            return "{}"
        return original(argv, input)

    runner.run = run
    nodes.HostConsole(runner).call("pve2", "remove")
    assert sent[0]["sources"] == {"nodes.py": "# source\n"}


def test_remove_cleans_only_the_retired_nodes_umiak_dnsmasq_instance(tmp_path):
    from umiak_installer.node_host import dispatch

    runner = FakeRunner(tmp_path)
    runner.objects["/nodes/pve/lxc"] = []
    runner.objects["/cluster/sdn/zones/umiak"] = {"type": "simple", "dhcp": "dnsmasq", "nodes": "pve,pve2"}
    own = runner.path("/etc/dnsmasq.d/umiak/umiak0.conf")
    own.parent.mkdir(parents=True)
    own.write_text("dhcp-range=10.88.0.100,10.88.0.250\n")
    foreign = runner.path("/etc/dnsmasq.d/other.conf")
    foreign.write_text("unrelated\n")
    original = runner.run
    runner.run = lambda argv, input=None: '{"report":[]}' if argv[0] == "lvs" else original(argv, input)
    dispatch(runner, {"op": "remove", "node": "pve", "control_plane_id": 590, "remaining_nodes": ["pve2"]})
    assert ["systemctl", "disable", "--now", "dnsmasq@umiak"] in runner.commands
    assert not own.exists()
    assert foreign.read_text() == "unrelated\n"
    assert not runner.dnsmasq_enabled


def test_new_node_storage_is_asked_from_that_nodes_lvm_thin_storages(tmp_path):
    from umiak_installer.main import Ui

    runner = FakeRunner(tmp_path)
    runner.objects["/storage"].append({"storage": "fast", "type": "lvmthin", "nodes": "pve2", "vgname": "f",
                                       "thinpool": "data"})
    answers = iter(["vmdata", "fast"])
    said = []
    ui = Ui(interactive=True, yes=False, input_fn=lambda prompt="": next(answers), out=said.append)
    assert nodes._ask_storage(runner, "pve2", "vmdata", ui) == "fast"
    assert any("No LVM-thin storage named vmdata on pve2; available: local-lvm, fast" in line for line in said)
    # Non-interactive: the control plane's storage, checked later by the node's inspect report.
    assert nodes._ask_storage(runner, "pve2", "vmdata", FakeUi(interactive=False)) == "vmdata"



def test_node_offered_after_install_needs_no_second_confirmation(tmp_path):
    # The offer's "Add pve2? [Y/n]" already confirmed: without host fixes there is no second prompt.
    runner = FakeRunner(tmp_path)
    secrets = runner.path("/var/lib/umiak-installer/secrets")
    secrets.mkdir(parents=True)
    (secrets / "known_hosts").write_text("")
    host = Host()
    host.call = lambda node, op, **data: {"checks": [], "sshHost": "192.168.68.11", "hostKey": "ssh-ed25519 new",
                                          "mediaStorage": "local"}
    ui = FakeUi()
    with pytest.raises(InstallerError) as error:
        nodes.add_node(runner, installed(), None, "pve2", ui=ui, console=Console(), host=host, confirmed=True)
    assert "Cancelled" not in str(error.value)  # it went past the confirmation to the reservation
    assert ui.prompts == []


def test_remove_refuses_the_control_plane_host_before_any_call(tmp_path):
    cp, host = Console(), Host()
    with pytest.raises(InstallerError, match="runs the Umiak control plane"):
        nodes.remove_node(FakeRunner(tmp_path), installed(), "pve", ui=FakeUi(yes=True), console=cp, host=host)
    assert cp.calls == [] and host.calls == []


def test_remove_asks_to_update_an_old_control_plane_without_removal_plan(tmp_path):
    class OldConsole(Console):
        def call(self, op, **data):
            if op == "removal-plan":
                raise CommandError(["pct"], 1, stderr="Unknown node console operation")
            return super().call(op, **data)

    cp, host = OldConsole(), Host()
    with pytest.raises(InstallerError, match="Update the control plane first"):
        nodes.remove_node(FakeRunner(tmp_path), installed(), "pve2", ui=FakeUi(yes=True), console=cp, host=host)
    assert host.calls == []
