import copy
import errno
import hashlib
import json
import stat

import pytest

from fake_pve import HOST_KEY, FakeRunner
from umiak_installer import host_report, prepare_host
from umiak_installer.pve import CommandError, InstallerError

SECRETS = ["pve-token", "pve-token-id", "pve-root-ca.pem", "umiak-node_ed25519", "umiak-node_ed25519.pub", "known_hosts"]
AGENT = b"fake-node-agent-binary"


def config(**changes):
    values = {"node": "pve", "storage": "local-lvm", "gateway_ip": "192.168.68.90", "guest_dns": "1.1.1.1",
              "vmid_min": 500, "vmid_max": 589, "tpl_min": 600, "tpl_max": 699}
    values.update(changes)
    return prepare_host.PrepareConfig(**values)


@pytest.fixture
def host(tmp_path):
    runner = FakeRunner(tmp_path / "host")
    out = tmp_path / "out"
    return runner, out


def snapshot(runner):
    return copy.deepcopy((runner.objects, runner.roles, runner.users, runner.tokens, runner.acls))


def test_fresh_host_creates_scoped_objects_and_secret_files(host):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)

    assert ["pveum", "user", "add", "umiak@pve", "--comment", "Umiak"] in runner.commands
    assert any(a[:6] == ["pveum", "user", "token", "add", "umiak@pve", "umiak"] for a in runner.commands)
    assert ["pveum", "pool", "add", "umiak", "--comment", "Umiak"] in runner.commands
    assert runner.objects["/cluster/sdn/zones/umiak"]["type"] == "simple"
    assert runner.objects["/cluster/sdn/vnets/umiak0"]["zone"] == "umiak"
    subnet = runner.objects["/cluster/sdn/vnets/umiak0/subnets/umiak-10.88.0.0-24"]
    assert subnet["subnet"] == "10.88.0.0/24" and subnet["snat"] == "1"
    assert [row["cidr"] for row in runner.objects["/cluster/firewall/ipset/umiak-gateway"]] == ["192.168.68.90"]
    rules = runner.objects["/cluster/firewall/groups/umiak-egress"]
    assert rules[0] == {"type": "out", "action": "ACCEPT", "proto": "tcp", "dport": "443",
                        "dest": "+umiak-gateway", "enable": "1", "pos": 0}
    assert len(rules) == 9
    # Every SDN apply restores the bridge multicast setting it may reset.
    assert runner.path("/sys/class/net/vmbr0/bridge/mcast_hash_max").read_text() == "1024"

    assert sorted(p.name for p in out.iterdir()) == sorted(SECRETS)
    for name in SECRETS:
        assert stat.S_IMODE((out / name).stat().st_mode) == 0o600, name
    assert (out / "pve-token").read_text() == "fake-secret-1"
    assert (out / "pve-token-id").read_text() == "umiak@pve!umiak"
    assert (out / "pve-root-ca.pem").read_text().startswith("-----BEGIN CERTIFICATE-----")
    assert (out / "known_hosts").read_text() == "192.168.68.10,pve " + " ".join(HOST_KEY.split()[:2]) + "\n"
    assert result.token_id == "umiak@pve!umiak"
    assert result.media_storage == "local"
    assert result.public_key == "ssh-ed25519 AAAAgeneratedNodeKey umiak-node"
    assert not any("fake-secret" in " ".join(a) for a in runner.commands)

    # Rollback was armed for the SDN/firewall changes and disarmed on success.
    assert any(a[:2] == ["systemd-run", "--quiet"] for a in runner.commands)
    assert runner.commands[-1] == ["systemctl", "stop", "umiak-installer-rollback.timer"]
    assert not runner.path("/var/lib/umiak-installer/active").exists()
    # No node-agent install here (ruling R2).
    assert not runner.path("/usr/local/bin/umiak-node").exists()


def test_rerun_is_noop_and_keeps_token(host):
    runner, out = host
    prepare_host.prepare(runner, config(), out)
    before = {name: (out / name).read_text() for name in SECRETS}
    runner.commands.clear()
    prepare_host.prepare(runner, config(), out)
    assert [a for a in runner.mutations() if a[0] != "systemd-run"] == []
    assert {name: (out / name).read_text() for name in SECRETS} == before


def test_missing_secret_file_rotates_existing_token(host):
    # Fix for the old dead end "token exists but secret unavailable": the
    # installer owns umiak@pve!umiak, so it may replace the token.
    runner, out = host
    prepare_host.prepare(runner, config(), out)
    (out / "pve-token").unlink()
    runner.commands.clear()
    prepare_host.prepare(runner, config(), out)
    token_cmds = [a for a in runner.commands if a[:3] == ["pveum", "user", "token"] and a[3] != "list"]
    assert [a[:6] for a in token_cmds] == [
        ["pveum", "user", "token", "remove", "umiak@pve", "umiak"],
        ["pveum", "user", "token", "add", "umiak@pve", "umiak"],
    ]
    assert (out / "pve-token").read_text() == "fake-secret-2"
    assert stat.S_IMODE((out / "pve-token").stat().st_mode) == 0o600
    # PVE drops a removed token's ACLs; the grants must be re-created.
    token_acls = {(x["path"], x["roleid"]) for x in runner.acls if x["ugid"] == "umiak@pve!umiak"}
    assert token_acls == {("/pool/umiak", "UmiakPoC"), ("/storage/local-lvm", "PVEDatastoreUser"),
                          ("/sdn/zones/umiak", "PVESDNUser"), ("/storage/local", "UmiakTemplateMedia"),
                          ("/pool/umiak", "UmiakConsole"), ("/nodes/pve", "UmiakMediaDownload"),
                          ("/", "UmiakDatacenterAudit")}
    # Access-only changes do not reload SDN.
    assert ["pvesh", "set", "/cluster/sdn"] not in runner.commands


def test_stale_secret_file_without_token_adds_token(host):
    runner, out = host
    prepare_host.prepare(runner, config(), out)
    runner.tokens.clear()
    prepare_host.prepare(runner, config(), out)
    assert (out / "pve-token").read_text() == "fake-secret-2"


@pytest.mark.parametrize("kind", ["zone", "vnet", "subnet"])
def test_foreign_pending_sdn_aborts_before_any_write(host, kind):
    runner, out = host
    if kind == "zone":
        runner.objects["/cluster/sdn/zones"] = [{"zone": "foreign", "pending": 1}]
    elif kind == "vnet":
        runner.objects["/cluster/sdn/vnets"] = [{"vnet": "foreign", "state": "new"}]
        runner.objects["/cluster/sdn/vnets/foreign/subnets"] = []
    else:
        runner.objects["/cluster/sdn/vnets"] = [{"vnet": "foreign"}]
        runner.objects["/cluster/sdn/vnets/foreign/subnets"] = [{"subnet": "foreign-10.9.0.0-24", "state": "changed"}]
    with pytest.raises(InstallerError, match="Pending SDN"):
        prepare_host.prepare(runner, config(), out)
    assert runner.mutations() == []
    assert not out.exists()
    assert not runner.path("/var/lib/umiak-installer").exists()


def test_disabled_firewall_aborts_before_any_write(tmp_path):
    runner = FakeRunner(tmp_path / "host", firewall=0)
    with pytest.raises(InstallerError, match="firewall"):
        prepare_host.prepare(runner, config(), tmp_path / "out")
    assert runner.mutations() == []


def test_other_node_name_is_refused(host):
    runner, out = host
    with pytest.raises(InstallerError, match="Node name"):
        prepare_host.prepare(runner, config(node="pve2"), out)
    assert runner.mutations() == []


def test_failure_rolls_back_then_rerun_succeeds(host):
    runner, out = host
    before = snapshot(runner)
    runner.fail_on = lambda argv: argv[:3] == ["pvesh", "create", "/cluster/firewall/groups/umiak-egress"] and "DROP" in argv
    with pytest.raises(CommandError) as failure:
        prepare_host.prepare(runner, config(), out)
    assert failure.value.stderr == "injected failure"
    assert snapshot(runner) == before
    assert not (out / "pve-token").exists()
    assert runner.path("/sys/class/net/vmbr0/bridge/mcast_hash_max").read_text() == "1024"
    assert not runner.path("/var/lib/umiak-installer/active").exists()
    assert runner.commands[-1] == ["systemctl", "stop", "umiak-installer-rollback.timer"]
    runner.fail_on = None
    prepare_host.prepare(runner, config(), out)
    assert (out / "pve-token").exists()


def test_existing_conflicting_topology_is_refused(host):
    runner, out = host
    runner.objects["/cluster/sdn/zones/umiak"] = {"type": "evpn"}
    with pytest.raises(InstallerError, match="differs"):
        prepare_host.prepare(runner, config(), out)
    assert runner.mutations() == []


def test_install_node_agent(host):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)
    binary = out.parent / "umiak-node"
    binary.write_bytes(AGENT)
    sha = hashlib.sha256(AGENT).hexdigest()

    prepare_host.install_node_agent(runner, binary, sha, result.public_key)
    prepare_host.install_node_agent(runner, binary, sha, result.public_key)

    installed = runner.path("/usr/local/bin/umiak-node")
    assert installed.read_bytes() == AGENT
    assert stat.S_IMODE(installed.stat().st_mode) == 0o755
    toml = runner.path("/etc/umiak-node.toml").read_text()
    for line in ['node = "pve"', 'vg = "pve"', 'thinPool = "data"', 'storage = "local-lvm"',
                 'isoDir = "/var/lib/vz/template/iso"', 'importDir = "/var/lib/vz/import"',
                 "vmidMin = 500", "vmidMax = 589", "templateVmidMin = 600", "templateVmidMax = 699",
                 "templateVmid = 0", 'sdnZone = "umiak"', 'vnet = "umiak0"', "clusterId = 1"]:
        assert line in toml.splitlines(), line
    keys = runner.path("/etc/pve/priv/authorized_keys").read_text().splitlines()
    forced = 'restrict,command="/usr/local/bin/umiak-node --stdio" ssh-ed25519 AAAAgeneratedNodeKey umiak-node'
    assert keys == ["ssh-rsa AAAA existing-management-key", forced]
    assert [str(installed), "--stdio"] in runner.commands


def test_install_node_agent_rejects_checksum_mismatch(host):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)
    binary = out.parent / "umiak-node"
    binary.write_bytes(AGENT)
    with pytest.raises(InstallerError, match="checksum"):
        prepare_host.install_node_agent(runner, binary, "0" * 64, result.public_key)
    assert not runner.path("/usr/local/bin/umiak-node").exists()
    assert runner.path("/etc/pve/priv/authorized_keys").read_text() == "ssh-rsa AAAA existing-management-key\n"


def test_install_node_agent_restores_files_when_probe_fails(host):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)
    binary = out.parent / "umiak-node"
    binary.write_bytes(AGENT)
    runner.fail_on = lambda argv: argv[-1] == "--stdio"
    with pytest.raises(CommandError):
        prepare_host.install_node_agent(runner, binary, hashlib.sha256(AGENT).hexdigest(), result.public_key)
    assert not runner.path("/usr/local/bin/umiak-node").exists()
    assert not runner.path("/etc/umiak-node.toml").exists()
    assert runner.path("/etc/pve/priv/authorized_keys").read_text() == "ssh-rsa AAAA existing-management-key\n"


def test_install_node_agent_requires_prepare(host):
    runner, out = host
    binary = out.parent / "umiak-node"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(AGENT)
    with pytest.raises(InstallerError, match="prepare"):
        prepare_host.install_node_agent(runner, binary, hashlib.sha256(AGENT).hexdigest(), "ssh-ed25519 AAAA x")


def test_host_report_shape(host):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)
    binary = out.parent / "umiak-node"
    binary.write_bytes(AGENT)
    prepare_host.install_node_agent(runner, binary, hashlib.sha256(AGENT).hexdigest(), result.public_key)
    runner.commands.clear()
    report = host_report.collect(runner, "pve")
    assert runner.mutations() == []
    assert set(report) == {"user", "token", "role", "downloadPrivileges", "pool", "zone", "vnet", "ipset",
                           "rules", "denySets", "firewall", "nodeFirewall", "vmFirewallsValid", "nodeAgent"}
    assert report["ipset"] == [{"cidr": "192.168.68.90", "comment": "Umiak guest gateway"}]
    assert report["rules"][0]["dest"] == "+umiak-gateway"
    assert report["denySets"] == {"umiak-deny": [], "umiak-deny6": [], "umiak-deny-public": []}
    assert report["zone"]["type"] == "simple" and report["vnet"]["zone"] == "umiak"
    assert report["vmFirewallsValid"] is True
    assert report["nodeAgent"]["ok"] is True
    path = host_report.write(report, out)
    assert json.loads(path.read_text()) == report
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_host_report_refuses_pending_sdn(host):
    runner, _ = host
    runner.objects["/cluster/sdn/zones"] = [{"zone": "foreign", "pending": 1}]
    with pytest.raises(InstallerError, match="Pending SDN"):
        host_report.collect(runner, "pve")


def test_armed_rollback_script_runs_standalone(host):
    import subprocess
    import sys

    runner, out = host
    prepare_host.prepare(runner, config(), out)
    state_dir = runner.path("/var/lib/umiak-installer")
    script = state_dir / "rollback.py"
    assert script.read_text() == (prepare_host.Path(prepare_host.rollback.__file__)).read_text()
    # Success cleared the active marker, so the timer's run is a no-op.
    done = subprocess.run([sys.executable, "-I", str(script), str(state_dir)], check=False, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_failed_timer_arm_does_not_block_reruns(host):
    runner, out = host
    runner.fail_on = lambda argv: argv[0] == "systemd-run"
    with pytest.raises(CommandError):
        prepare_host.prepare(runner, config(), out)
    assert not runner.path("/var/lib/umiak-installer/active").exists()
    assert [a for a in runner.mutations() if a[0] != "systemd-run"] == []
    runner.fail_on = None
    prepare_host.prepare(runner, config(), out)
    assert (out / "pve-token").exists()


def test_incomplete_rollback_keeps_timer_and_explains_retry(host):
    runner, out = host
    runner.fail_on = lambda argv: argv[:4] in (["pveum", "user", "token", "add"], ["pveum", "role", "delete", "UmiakPoC"])
    with pytest.raises(CommandError):
        prepare_host.prepare(runner, config(), out)
    state_dir = runner.path("/var/lib/umiak-installer")
    assert (state_dir / "active").exists()
    assert ["systemctl", "stop", "umiak-installer-rollback.timer"] not in runner.commands
    runner.fail_on = None
    with pytest.raises(InstallerError, match="rollback.py") as refused:
        prepare_host.prepare(runner, config(), out)
    assert f"python3 {state_dir / 'rollback.py'} {state_dir}" in str(refused.value)


def test_relative_out_dir_is_journaled_absolute(host, monkeypatch):
    runner, out = host
    monkeypatch.chdir(out.parent)
    runner.fail_on = lambda argv: argv[:3] == ["pvesh", "create", "/cluster/sdn/zones"]
    with pytest.raises(CommandError):
        prepare_host.prepare(runner, config(), prepare_host.Path("out"))
    journal = json.loads(runner.path("/var/lib/umiak-installer/undo.json").read_text())
    files = [action[1] for action in journal if action[0] == "file"]
    assert files == [str(out.resolve() / "pve-token")]


def _agent(out):
    binary = out.parent / "umiak-node"
    binary.write_bytes(AGENT)
    return binary, hashlib.sha256(AGENT).hexdigest()


def test_failed_install_removes_only_its_own_key_line(host):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)
    binary, sha = _agent(out)
    keys = runner.path("/etc/pve/priv/authorized_keys")

    def probe_fails_after_concurrent_edit(argv):
        if argv[-1] == "--stdio":
            # Another node adds its key while we run: it must survive our cleanup.
            keys.write_text(keys.read_text() + "ssh-ed25519 AAAA other-node\n")
            return True
        return False

    runner.fail_on = probe_fails_after_concurrent_edit
    with pytest.raises(CommandError):
        prepare_host.install_node_agent(runner, binary, sha, result.public_key)
    assert keys.read_text() == "ssh-rsa AAAA existing-management-key\nssh-ed25519 AAAA other-node\n"
    assert sorted(p.name for p in keys.parent.iterdir()) == ["authorized_keys"]


def test_failed_install_keeps_preexisting_key_line(host):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)
    binary, sha = _agent(out)
    prepare_host.install_node_agent(runner, binary, sha, result.public_key)
    keys = runner.path("/etc/pve/priv/authorized_keys")
    before = keys.read_text()
    runner.fail_on = lambda argv: argv[-1] == "--stdio"
    with pytest.raises(CommandError):
        prepare_host.install_node_agent(runner, binary, sha, result.public_key)
    assert keys.read_text() == before


def test_restore_failure_does_not_mask_error_or_skip_other_files(host, monkeypatch):
    runner, out = host
    result = prepare_host.prepare(runner, config(), out)
    binary, sha = _agent(out)
    prepare_host.install_node_agent(runner, binary, sha, result.public_key)
    target = runner.path("/usr/local/bin/umiak-node")
    config_path = runner.path("/etc/umiak-node.toml")
    old_config = config_path.read_bytes()

    new_agent = b"newer-agent"
    binary.write_bytes(new_agent)
    real_replace = prepare_host._replace

    probed = []

    def replace(path, data, mode):
        if probed and path == config_path and data == old_config:
            raise OSError("restore of config failed")
        return real_replace(path, data, mode)

    real_write_bytes = prepare_host.Path.write_bytes

    def write_bytes(self, data):
        if self == target:  # a running binary cannot be written in place
            raise OSError(errno.ETXTBSY, "Text file busy")
        return real_write_bytes(self, data)

    monkeypatch.setattr(prepare_host, "_replace", replace)
    monkeypatch.setattr(prepare_host.Path, "write_bytes", write_bytes)
    runner.fail_on = lambda argv: argv[-1] == "--stdio" and not probed.append(1)
    with pytest.raises(CommandError):
        prepare_host.install_node_agent(runner, binary, hashlib.sha256(new_agent).hexdigest(), result.public_key)
    # The binary was restored by rename (no in-place write of a running file).
    assert target.read_bytes() == AGENT
    assert stat.S_IMODE(target.stat().st_mode) == 0o755
    assert not any(p.name.endswith(".umiak-new") for p in target.parent.iterdir())
