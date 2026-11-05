import json
import re
import stat
from pathlib import Path

import pytest

from fake_ct import CtFake, ps_rows
from umiak_installer import release, stack
from umiak_installer.pve import CommandError, InstallerError

SECRET = "super-secret-token-value"
ENV = {
    "UMIAK_VERSION": "1.2.3",
    "UMIAK_PUBLIC_URL": "https://umiak.tail0000.ts.net",
    "UMIAK_PREVIEW_DOMAIN": "umiak.100-64-10-20.sslip.io",
    "UMIAK_SSH_HOST": "100.64.10.20",
    "UMIAK_GATEWAY_TLS_BIND": "192.168.68.60",
}


def make_bundle(root, version="1.2.3"):
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION").write_text(version + "\n")
    for name in stack.STACK_FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# " + name + "\n")
    (root / "node-agent.sha256").write_text("0" * 64 + "\n")
    return release.Release(version, root)


@pytest.fixture
def runner(tmp_path):
    return CtFake(tmp_path / "host")


REPO_ROOT = Path(__file__).resolve().parents[3]


def test_stack_files_are_exactly_compose_and_its_bind_mounts():
    compose = (REPO_ROOT / "compose.yaml").read_text()
    mounts = set(re.findall(r"^\s*- \./([^:\s]+):", compose, re.M))
    assert set(stack.STACK_FILES) == {"compose.yaml", *mounts}


def test_web_meta_presents_the_public_api_host():
    compose = (REPO_ROOT / "compose.yaml").read_text()
    block = compose.split("\n  web-meta:\n", 1)[1].split("\n\n", 1)[0]
    assert "UMIAK_API_URL: ${UMIAK_PUBLIC_URL:-http://localhost:4180}" in block
    assert not re.search(r"UMIAK_API_URL: http", compose)


def test_network_json_is_byte_identical_to_quickstart_network_step():
    content = stack.network_json("192.168.68.50", "umiak.100-64-10-20.sslip.io", "1.1.1.1")
    assert content == (
        b'{"gatewayAddress":"192.168.68.50","previewDomain":"umiak.100-64-10-20.sslip.io",'
        b'"tunnelUrl":"wss://tunnel.192-168-68-50.sslip.io/v1/connect","guestDns":"1.1.1.1","guestSubnet":"10.88.0.0/24"}'
    )


def test_env_contains_exactly_the_four_public_keys():
    text = stack.env_text(ENV)
    assert [line.split("=", 1)[0] for line in text.splitlines()] == list(stack.ENV_KEYS)
    assert "UMIAK_PUBLIC_URL=https://umiak.tail0000.ts.net\n" in text
    with pytest.raises(InstallerError):
        stack.env_text({**ENV, "UMIAK_PVE_TOKEN": SECRET})
    with pytest.raises(InstallerError):
        stack.env_text({k: v for k, v in ENV.items() if k != "UMIAK_SSH_HOST"})
    with pytest.raises(InstallerError):
        stack.env_text({**ENV, "UMIAK_PUBLIC_URL": "https://x\nUMIAK_EVIL=1"})


def test_write_pushes_compose_files_and_env(runner, tmp_path):
    bundle = make_bundle(tmp_path / "bundle")
    stack.write(runner, 591, bundle, ENV, work_dir=tmp_path / "work")
    assert runner.pushed["/opt/umiak/compose.yaml"] == b"# compose.yaml\n"
    assert runner.pushed["/opt/umiak/deploy/compose/quickstart/run.mjs"] == b"# deploy/compose/quickstart/run.mjs\n"
    assert runner.pushed["/opt/umiak/.env"].decode() == stack.env_text(ENV)


def test_push_secrets_never_puts_secret_values_in_argv_or_env(runner, tmp_path):
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    files = {}
    for name in stack.SECRET_NAMES:
        (secrets / name).write_text(SECRET + "-" + name)
        (secrets / name).chmod(0o600)
        files[name] = secrets / name
    bundle = make_bundle(tmp_path / "bundle")
    stack.write(runner, 591, bundle, ENV, work_dir=tmp_path / "work")
    stack.push_secrets(runner, 591, files, "ghcr.io/belov38/umiak-quickstart:1.2.3")

    assert not any(SECRET in " ".join(argv) for argv in runner.commands)
    assert not any(input and SECRET in input for input in runner.inputs)
    assert SECRET not in runner.pushed["/opt/umiak/.env"].decode()
    pushes = [a for a in runner.commands if a[:2] == ["pct", "push"] and a[4].startswith(stack.STAGING)]
    assert sorted(a[4].rsplit("/", 1)[1] for a in pushes) == sorted(stack.SECRET_NAMES)
    assert all(a[-2:] == ["--perms", "0600"] for a in pushes)
    copy = next(a for a in runner.ct_commands() if a[:2] == ["docker", "run"])
    assert "umiak_pve-secrets:/s" in copy and "--network" in copy
    # Staging is removed even after a successful copy.
    assert runner.ct_commands()[-1] == ["rm", "-rf", stack.STAGING]


def test_push_secrets_rejects_unknown_or_world_readable_files(runner, tmp_path):
    path = tmp_path / "pve-token"
    path.write_text(SECRET)
    path.chmod(0o644)
    with pytest.raises(InstallerError):
        stack.push_secrets(runner, 591, {"pve-token": path}, "img")
    path.chmod(0o600)
    with pytest.raises(InstallerError):
        stack.push_secrets(runner, 591, {"../evil": path}, "img")


def test_push_secrets_cleans_staging_on_failure(runner, tmp_path):
    path = tmp_path / "pve-token"
    path.write_text(SECRET)
    path.chmod(0o600)
    runner.fail_on = lambda argv: "docker" in argv and "run" in argv
    with pytest.raises(CommandError):
        stack.push_secrets(runner, 591, {"pve-token": path}, "img")
    assert runner.ct_commands()[-1] == ["rm", "-rf", stack.STAGING]


def test_write_network_copies_exact_bytes_into_named_volume(runner, tmp_path):
    content = stack.network_json("192.168.68.50", "umiak.100-64-10-20.sslip.io", "1.1.1.1")
    stack.write_network(runner, 591, content, "img", work_dir=tmp_path / "work")
    assert runner.pushed[stack.STAGING + "/quickstart-network.json"] == content
    copy = next(a for a in runner.ct_commands() if a[:2] == ["docker", "run"])
    assert "umiak_network-config:/n" in copy


def test_firewall_unit_drops_owner_ports_on_eth0_except_from_node(runner, tmp_path):
    stack.write_firewall(runner, 591, "192.168.68.10")
    script = next(i for a, i in zip(runner.commands, runner.inputs, strict=True)
                  if a[:2] == ["pct", "exec"] and a[-1] == stack.FIREWALL_SCRIPT)
    for port in ("4180", "8085", "2222"):
        assert (f"iptables -A UMIAK-PORTS -i eth0 -p tcp -m conntrack --ctproto tcp --ctdir ORIGINAL "
                f"--ctorigdstport {port} ! -s 192.168.68.10 -j DROP") in script
    assert "443" not in script
    # Idempotent: the chain is flushed and the jump added only once.
    assert "iptables -F UMIAK-PORTS" in script
    assert "iptables -C DOCKER-USER -j UMIAK-PORTS" in script
    unit = next(i for a, i in zip(runner.commands, runner.inputs, strict=True)
                if a[:2] == ["pct", "exec"] and a[-1] == stack.FIREWALL_UNIT)
    # Rules exist before Docker starts containers at boot; Docker keeps an existing DOCKER-USER chain.
    assert "Before=docker.service" in unit and "After=docker.service" not in unit
    assert "WantedBy=multi-user.target docker.service" in unit
    assert script.index("iptables -N DOCKER-USER") < script.index("iptables -C DOCKER-USER")
    assert ["systemctl", "enable", "umiak-ports.service"] in runner.ct_commands()
    assert ["systemctl", "restart", "umiak-ports.service"] in runner.ct_commands()
    with pytest.raises(InstallerError):
        stack.write_firewall(runner, 591, "192.168.68.10; reboot")


def test_up_pulls_then_waits_for_healthy_services(runner):
    runner.ps_payloads = [ps_rows(health="starting"), ps_rows()]
    stack.up(runner, 591, sleep=lambda _: None)
    compose = [a for a in runner.ct_commands() if a[:2] == ["docker", "compose"]]
    verbs = [a[a.index("--project-directory") + 2] for a in compose]
    assert verbs.index("pull") < verbs.index("up")
    assert verbs.count("ps") == 2


def test_up_fails_when_one_shot_service_fails(runner):
    runner.ps_payloads = [ps_rows(oneshot_exit=1)]
    with pytest.raises(InstallerError, match="exited"):
        stack.up(runner, 591, sleep=lambda _: None)


def test_up_times_out(runner):
    runner.ps_payloads = [ps_rows(health="starting")]
    clock = iter(range(0, 10_000, 10))
    with pytest.raises(InstallerError, match="healthy"):
        stack.up(runner, 591, sleep=lambda _: None, clock=lambda: next(clock))


def test_extract_node_agent_uses_docker_cp_and_pct_pull(runner, tmp_path):
    dest = tmp_path / "agent"
    stack.extract_node_agent(runner, 591, "ghcr.io/belov38/umiak-quickstart:1.2.3", dest)
    inside = runner.ct_commands()
    assert ["docker", "create", "--name", "umiak-node-extract", "ghcr.io/belov38/umiak-quickstart:1.2.3"] in inside
    assert ["docker", "cp", "umiak-node-extract:/app/quickstart-assets/umiak-node-linux-amd64",
            "/root/umiak-node-linux-amd64"] in inside
    assert ["pct", "pull", "591", "/root/umiak-node-linux-amd64", str(dest)] in runner.commands
    assert dest.read_bytes() == b"fake-node-agent-binary"
    assert stat.S_IMODE(dest.stat().st_mode) == 0o600


def test_claim_code_parser_takes_latest_code_and_ignores_other_lines():
    logs = (
        "quickstart-1  | Umiak owner HTTP ingress ready on :4180\n"
        "quickstart-1  | Umiak one-time setup code: OLDcode1\n"
        "quickstart-1  | something about setup code: nope\n"
        "quickstart-1  | Umiak one-time setup code: NEWcode2\n"
    )
    assert stack.claim_code(logs) == "NEWcode2"
    assert stack.claim_code("quickstart-1  | ready\n") is None


def test_install_json_matches_bootstrap_contract():
    data = stack.install_json(
        release="1.2.3", node="pve", node_ip="192.168.68.10", fingerprint="ab" * 32, ct_ip="192.168.68.50",
        guest_dns="1.1.1.1", tailnet_dns="umiak.tail0000.ts.net", tailnet_ip="100.64.10.20",
        limits={"storage": "local-lvm", "vmidMin": 500, "vmidMax": 589, "ramCapMb": 8192,
                "templateVmidMin": 600, "templateVmidMax": 699},
    )
    assert data == {
        "version": 1,
        "release": "1.2.3",
        "channel": "stable",
        "connection": {"apiUrl": "https://192.168.68.10:8006", "node": "pve", "tokenId": "umiak@pve!umiak",
                       "fingerprint": "ab" * 32, "tlsName": "pve", "sshHost": "192.168.68.10"},
        "limits": {"storage": "local-lvm", "vmidMin": 500, "vmidMax": 589, "ramCapMb": 8192,
                   "templateVmidMin": 600, "templateVmidMax": 699},
        "network": {"gatewayAddress": "192.168.68.50", "guestDns": "1.1.1.1",
                    "previewDomain": "umiak.100-64-10-20.sslip.io", "sshHost": "100.64.10.20", "guestSubnet": "10.88.0.0/24"},
        "publicUrl": "https://umiak.tail0000.ts.net",
    }
    json.dumps(data)


def test_wait_bootstrap_reports_import_failure_since_last_start(runner):
    runner.logs = "installer import failed: boom\nUmiak owner HTTP ingress ready on :4180\n"
    with pytest.raises(InstallerError, match="boom"):
        stack.wait_bootstrap(runner, 591, sleep=lambda _: None)
    runner.logs = "Umiak owner HTTP ingress ready on :4180\n"
    stack.wait_bootstrap(runner, 591, sleep=lambda _: None)


def test_wait_bootstrap_times_out_without_ready_line(runner):
    runner.logs = "starting\n"
    with pytest.raises(InstallerError, match="did not start"):
        stack.wait_bootstrap(runner, 591, sleep=lambda _: None, attempts=3)


def test_quickstart_running_probe(runner):
    assert stack.quickstart_running(runner, 591) is False
    runner.quickstart_running = True
    assert stack.quickstart_running(runner, 591) is True


def test_pull_reports_one_line_per_image(tmp_path):
    import json as _json

    from fake_ct import CtFake

    runner = CtFake(tmp_path / "host")
    original = runner.run
    config = {"services": {"api": {"image": "ghcr.io/belov38/umiak-quickstart:1"},
                           "worker": {"image": "ghcr.io/belov38/umiak-quickstart:1"},
                           "web": {"image": "ghcr.io/belov38/umiak-web:1"}}}

    def run(argv, input=None):
        if "config" in argv and "json" in argv:
            runner.commands.append(list(argv))
            return _json.dumps(config)
        return original(argv, input=input)

    runner.run = run
    said = []
    stack.pull(runner, 591, say=said.append)
    assert said == ["Downloading image 1/2: umiak-quickstart:1", "Downloading image 2/2: umiak-web:1"]
    pulls = [a for a in runner.ct_commands() if "pull" in a]
    assert [a[-1] for a in pulls] == ["api", "web"]
