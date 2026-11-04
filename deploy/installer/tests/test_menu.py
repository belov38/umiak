import hashlib
import json

import pytest

from fake_ct import AGENT, CERT_DER, CODE, TS_STATUS, CtFake
from test_stack import make_bundle
from umiak_installer import main, stack, state

FLAGS = ["--non-interactive", "--yes", "--storage", "local-lvm", "--ct-id", "591", "--ct-ip", "192.168.68.50",
         "--gateway-cidr", "192.168.68.1/22", "--vmid-range", "500-589", "--template-range", "600-699",
         "--ram-cap-mb", "8192", "--hostname", "umiak"]


def sample(phase):
    return state.InstallState(version=1, ct_id=591, ct_ip="192.168.68.50", node="pve", release="1.2.3",
                              tailnet_host=None, phase=phase)


def test_menu_options_follow_state():
    assert main.menu_options(None) == ["Install"]
    assert main.menu_options(sample("ct-created")) == ["Resume install", "Uninstall"]
    assert main.menu_options(sample("prepared")) == ["Resume install", "Uninstall"]
    assert main.menu_options(sample("complete")) == ["Update", "Sign in a new browser", "Reset owner access", "Uninstall"]


@pytest.fixture
def env(tmp_path):
    runner = CtFake(tmp_path / "host")
    bundle = make_bundle(tmp_path / "bundle")
    (bundle.root / "node-agent.sha256").write_text(hashlib.sha256(AGENT).hexdigest() + "\n")
    printed = []

    def run(argv, **kwargs):
        return main.main(argv, runner=runner, bundle=bundle, out=printed.append, sleep=lambda _: None, **kwargs)

    return runner, run, printed


def saved(runner):
    return state.load(runner.path(str(state.DEFAULT_PATH)))


def test_non_interactive_install_end_to_end(env):
    runner, run, printed = env
    assert run(FLAGS) == 0
    assert printed[-1] == f"Open https://umiak.tail0000.ts.net/claim#{CODE}"
    final = saved(runner)
    assert final.phase == "complete" and final.tailnet_host == "umiak.tail0000.ts.net" and final.ct_id == 591

    cmds = runner.commands
    inside = runner.ct_commands()

    def first(predicate, items):
        return next(n for n, a in enumerate(items) if predicate(a))

    # Order: PVE objects, CT, tailnet login, stack files, node-agent, secrets, up, serve.
    sdn = first(lambda a: a[:3] == ["pvesh", "set", "/cluster/sdn"], cmds)
    create = first(lambda a: a[:2] == ["pct", "create"], cmds)
    assert sdn < create
    ts_up = first(lambda a: a[:2] == ["tailscale", "up"], inside)
    pull = first(lambda a: "pull" in a and a[:2] == ["docker", "compose"], inside)
    extract = first(lambda a: a[:2] == ["docker", "create"], inside)
    copy_secrets = first(lambda a: a[:2] == ["docker", "run"] and "umiak_pve-secrets:/s" in a, inside)
    up = first(lambda a: a[:2] == ["docker", "compose"] and "up" in a, inside)
    serve = first(lambda a: a[:2] == ["tailscale", "serve"], inside)
    assert ts_up < pull < extract < copy_secrets < up < serve

    # Node-agent installed on the node from the image, before the stack starts.
    assert runner.path("/usr/local/bin/umiak-node").read_bytes() == AGENT
    # The gateway IPSet holds the CT LAN address.
    assert [r["cidr"] for r in runner.objects["/cluster/firewall/ipset/umiak-gateway"]] == ["192.168.68.50"]

    pushed = runner.pushed
    install = json.loads(pushed[stack.STAGING + "/install.json"])
    assert install["connection"]["fingerprint"] == hashlib.sha256(CERT_DER).hexdigest()
    assert install["connection"]["apiUrl"] == "https://192.168.68.10:8006"
    assert install["network"] == {"gatewayAddress": "192.168.68.50", "guestDns": "1.1.1.1",
                                  "previewDomain": "umiak.100-64-10-20.sslip.io", "sshHost": "100.64.10.20"}
    assert install["limits"]["ramCapMb"] == 8192
    assert json.loads(pushed[stack.STAGING + "/host-report.json"])["nodeAgent"]["ok"] is True
    assert set(stack.SECRET_NAMES) <= {k.rsplit("/", 1)[1] for k in pushed if k.startswith(stack.STAGING)}
    assert pushed[stack.STAGING + "/quickstart-network.json"] == stack.network_json(
        "192.168.68.50", "umiak.100-64-10-20.sslip.io", "1.1.1.1")
    assert "UMIAK_PUBLIC_URL=https://umiak.tail0000.ts.net" in pushed["/opt/umiak/.env"].decode()
    # The token secret never appears in argv, stdin or printed output.
    token = runner.path("/var/lib/umiak-installer/secrets/pve-token").read_text()
    assert not any(token in " ".join(a) for a in cmds)
    assert not any(i and token in i for i in runner.inputs)
    assert not any(token in line for line in printed)


def test_tailnet_without_https_stops_non_interactive_with_exit_3_then_resumes(env):
    runner, run, printed = env
    runner.ts_states = [{**TS_STATUS, "CertDomains": []}]
    assert run(FLAGS) == 3
    assert any("https://login.tailscale.com/admin/dns" in line for line in printed)
    assert not any("/claim#" in line for line in printed)
    assert saved(runner).phase == "ct-created"
    assert main.menu_options(saved(runner)) == ["Resume install", "Uninstall"]

    # Rerun resumes from saved answers: no second CT, no duplicate PVE objects.
    runner.ts_states = [TS_STATUS]
    creates = sum(a[:2] == ["pct", "create"] for a in runner.commands)
    runner.commands.clear()
    assert run(["--non-interactive", "--yes"]) == 0
    assert creates == 1 and not any(a[:2] == ["pct", "create"] for a in runner.commands)
    assert not any(a[:3] == ["pveum", "user", "add"] for a in runner.commands)
    assert saved(runner).phase == "complete"


def test_interactive_tailnet_not_ready_waits_for_enter_and_rechecks(env):
    runner, run, printed = env
    runner.ts_states = [{**TS_STATUS, "CertDomains": []}, {**TS_STATUS, "CertDomains": []}, TS_STATUS]
    # Menu choice, confirm the listed host changes, then Enter after each HTTPS hint.
    answers = iter(["1", "y", "", ""])
    assert run(FLAGS[2:], input_fn=lambda prompt="": next(answers)) == 0
    assert any("https://login.tailscale.com/admin/dns" in line for line in printed)


def test_non_interactive_requires_ct_ip(env):
    runner, run, printed = env
    flags = [f for f in FLAGS if f not in ("--ct-ip", "192.168.68.50")]
    assert run(flags) == 2
    assert not any(a[0] in ("pct", "pveum") and "list" not in a for a in runner.commands)


def test_failing_check_without_yes_is_not_fixed_non_interactive(env):
    runner, run, printed = env
    runner.ip_forward = "0"
    assert run([f for f in FLAGS if f != "--yes"]) == 1
    assert not runner.path("/etc/sysctl.d/99-umiak.conf").exists()
    assert any("ip-forward" in line or "forwarding" in line for line in printed)


def test_yes_applies_listed_fix(env):
    runner, run, printed = env
    runner.ip_forward = "0"
    original = runner.run

    def run_cmd(argv, input=None):
        if argv[:2] == ["sysctl", "--system"]:
            runner.ip_forward = "1"
        return original(argv, input)

    runner.run = run_cmd
    assert run(FLAGS) == 0
    assert runner.path("/etc/sysctl.d/99-umiak.conf").read_text() == "net.ipv4.ip_forward = 1\n"


def test_rejects_sandbox_range_other_than_bootstrap_contract(env):
    runner, run, printed = env
    flags = list(FLAGS)
    flags[flags.index("500-589")] = "500-520"
    assert run(flags) == 2


def test_complete_install_does_not_reinstall(env):
    runner, run, printed = env
    state.save(sample("complete"), runner.path(str(state.DEFAULT_PATH)))
    assert run(["--non-interactive"]) == 2
    assert not any(a[0] == "pct" for a in runner.commands)
