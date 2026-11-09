import hashlib
import json

import pytest

from fake_ct import AGENT, CERT_DER, CODE, TS_STATUS, CtFake
from test_stack import make_bundle
from umiak_installer import main, stack, state
from umiak_installer.pve import CommandError

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
    assert main.menu_options(sample("complete")) == [
        "Update", "Sign in a new browser", "Reset owner access", "Add a sandbox node", "Remove a sandbox node", "Uninstall",
    ]


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
    # The claim link stands alone near the end, set off by blank lines.
    assert printed[-4:] == ["▶ On a device in your tailnet, open:",
                            f"  https://umiak.tail0000.ts.net/claim#{CODE}",
                            "  One-time link, do not share it.",
                            "  Then build the Linux template (~10 min) and run the test."]
    assert "Tip: disable key expiry for 'umiak' in Tailscale, or it drops off in ~180 days:" in printed
    assert "  https://login.tailscale.com/admin/machines" in printed
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
                                  "previewDomain": "umiak.100-64-10-20.sslip.io", "sshHost": "100.64.10.20",
                                  "guestSubnet": "10.88.0.0/18"}
    assert install["limits"]["ramCapMb"] == 8192
    assert json.loads(pushed[stack.STAGING + "/host-report.json"])["nodeAgent"]["ok"] is True
    assert set(stack.SECRET_NAMES) <= {k.rsplit("/", 1)[1] for k in pushed if k.startswith(stack.STAGING)}
    assert pushed[stack.STAGING + "/quickstart-network.json"] == stack.network_json(
        "192.168.68.50", "umiak.100-64-10-20.sslip.io", "1.1.1.1", "10.88.0.0/18")
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
    # A single-option menu (Install) is skipped: confirm the host changes, then Enter after each HTTPS hint.
    answers = iter(["y", "", ""])
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
    runner.path("/etc/sysctl.d/99-umiak.conf").unlink(missing_ok=True)
    assert run([f for f in FLAGS if f != "--yes"]) == 2
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


def test_accepts_custom_sandbox_range(env):
    runner, run, printed = env
    flags = list(FLAGS)
    flags[flags.index("500-589")] = "710-799"
    assert run(flags) == 0
    assert saved(runner).answers["vmid_min"] == 710


def test_complete_install_does_not_reinstall(env):
    runner, run, printed = env
    state.save(sample("complete"), runner.path(str(state.DEFAULT_PATH)))
    assert run(["--non-interactive"]) == 2
    assert not any(a[0] == "pct" for a in runner.commands)


def test_non_interactive_without_yes_is_a_usage_error_before_changes(env):
    runner, run, printed = env
    assert run([f for f in FLAGS if f != "--yes"]) == 2
    assert any("--yes" in line for line in printed)
    assert runner.mutations() == []


@pytest.mark.parametrize("flag,value", [("--ct-ip", "192.168.68.1"), ("--ct-ip", "10.0.0.5"), ("--gateway-cidr", "x")])
def test_invalid_answers_are_usage_errors(env, flag, value):
    runner, run, printed = env
    flags = list(FLAGS)
    flags[flags.index(flag) + 1] = value
    assert run(flags) == 2
    assert runner.mutations() == []


def test_foreign_ct_id_and_used_ip_are_refused_before_any_change(env):
    runner, run, printed = env
    runner.objects["/cluster/resources"].append({"vmid": 591, "type": "lxc", "name": "other", "tags": "home"})
    assert run(FLAGS) == 2
    assert any("591" in line for line in printed)
    assert runner.mutations() == [] and state.load(runner.path(str(state.DEFAULT_PATH))) is None
    runner.objects["/cluster/resources"].pop()
    runner.ip_in_use = True
    assert run(FLAGS) == 2
    assert any("in use" in line for line in printed)
    assert runner.mutations() == []


def stuck_state(runner, phase="prepared", **answers):
    base = {"storage": "local-lvm", "vmid_min": 500, "vmid_max": 589, "tpl_min": 600, "tpl_max": 699,
            "ram_cap_mb": 8192, "ct_id": 591, "ct_ip": "192.168.68.50", "gw": "192.168.68.1", "cidr": 22,
            "hostname": "umiak", "guest_dns": "1.1.1.1"}
    base.update(answers)
    state.save(state.InstallState(version=1, ct_id=base["ct_id"], ct_ip=base["ct_ip"], node="pve", release="1.2.3",
                                  tailnet_host=None, phase=phase, answers=base),
               runner.path(str(state.DEFAULT_PATH)))


def test_resume_before_ct_created_accepts_flag_overrides_for_bad_saved_answers(env):
    runner, run, printed = env
    runner.objects["/cluster/resources"].append({"vmid": 591, "type": "lxc", "name": "other", "tags": "home"})
    stuck_state(runner)
    # Saved CT ID belongs to someone else: resume refuses with a usage error ...
    assert run(["--non-interactive", "--yes"]) == 2
    assert not any(a[:2] == ["pct", "create"] for a in runner.commands)
    # ... and a flag override fixes it.
    assert run(["--non-interactive", "--yes", "--ct-id", "592"]) == 0
    final = saved(runner)
    assert final.phase == "complete" and final.ct_id == 592 and final.answers["ct_id"] == 592
    assert any(a[:3] == ["pct", "create", "592"] for a in runner.commands)


def test_interactive_resume_re_asks_with_saved_defaults(env):
    runner, run, printed = env
    runner.ip_in_use = True
    stuck_state(runner)
    prompts = []

    def answer(prompt=""):
        prompts.append(prompt)
        if prompt.startswith("Choose"):
            return "1"
        if "[y/N]" in prompt:
            return "y"
        if prompt.startswith("Control-plane static IPv4 address"):
            runner.ip_in_use = False
            return "192.168.68.51"
        return ""

    assert run([], input_fn=answer) == 0
    assert not any(p.startswith("Control-plane CT ID") for p in prompts)
    assert any(p.startswith("Control-plane static IPv4 address [192.168.68.50]") for p in prompts)
    assert saved(runner).ct_ip == "192.168.68.51"


def test_resume_after_ct_created_keeps_saved_answers(env):
    runner, run, printed = env
    runner.objects["/cluster/resources"].append({"vmid": 591, "type": "lxc", "name": "umiak-cp", "tags": "umiak"})
    runner.ip_in_use = True  # the CT itself answers ping
    stuck_state(runner, phase="ct-created")
    assert run(["--non-interactive", "--yes"]) == 0
    assert not any(a[:2] == ["pct", "create"] for a in runner.commands)


def test_failed_bootstrap_import_stops_before_stack_up(env):
    runner, run, printed = env
    runner.logs = ("Umiak one-time setup code: X\n"
                   "installer import failed: Restricted node-agent configuration mismatch\n"
                   "Umiak owner HTTP ingress ready on :4180\n")
    assert run(FLAGS) == 1
    assert any("Restricted node-agent configuration mismatch" in line for line in printed)
    assert not any("/claim#" in line for line in printed)
    assert saved(runner).phase == "tailnet-up"
    logs = next(a for a in runner.ct_commands() if "logs" in a)
    assert "--since" in logs and logs[logs.index("--since") + 1] == "2026-11-04T10:00:00.000000000Z"


def test_quickstart_running_before_secrets_is_restarted(env):
    runner, run, printed = env
    runner.quickstart_running = True
    assert run(FLAGS) == 0
    inside = runner.ct_commands()
    push = max(n for n, a in enumerate(inside) if a[:2] == ["docker", "run"])
    restart = next(n for n, a in enumerate(inside) if a[:2] == ["docker", "compose"] and "restart" in a)
    assert push < restart and "quickstart" in inside[restart]


def test_fresh_start_is_not_restarted(env):
    runner, run, printed = env
    assert run(FLAGS) == 0
    assert not any(a[:2] == ["docker", "compose"] and "restart" in a for a in runner.ct_commands())


def test_command_failure_names_step_inner_command_and_stderr_tail(env):
    runner, run, printed = env
    original = runner.run
    stderr = "".join(f"err line {n}\n" for n in range(1, 31))

    def failing(argv, input=None):
        if argv[:2] == ["pct", "exec"] and "pull" in argv and "compose" in argv:
            raise CommandError(list(argv), 18, "", stderr)
        return original(argv, input)

    runner.run = failing
    assert run(FLAGS) == 1
    text = "\n".join(printed)
    assert "Starting the Umiak stack" in text
    assert "docker compose --project-directory /opt/umiak pull --quiet" in text
    assert "pct exec 591" not in text
    assert "exit code 18" in text
    lines = text.splitlines()
    assert "err line 30" in lines and "err line 11" in lines and "err line 10" not in lines


def test_main_turns_on_line_buffering(env, monkeypatch):
    runner, run, printed = env
    calls = []

    class Stream:
        def reconfigure(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(main.sys, "stdout", Stream())
    monkeypatch.setattr(main.sys, "stderr", Stream())
    run(FLAGS)
    assert calls == [{"line_buffering": True}] * 2


def test_guest_dns_flag_reaches_pct_create(env):
    runner, run, printed = env
    assert run(FLAGS + ["--guest-dns", "9.9.9.9"]) == 0
    create = next(a for a in runner.commands if a[:2] == ["pct", "create"])
    assert create[create.index("--nameserver") + 1] == "9.9.9.9"


def test_interactive_install_reasks_bad_answers_and_suggests_a_free_ip(env):
    runner, run, printed = env
    runner.objects["/cluster/resources"].append({"vmid": 590, "type": "lxc", "name": "home", "tags": "home"})
    guest = runner.path("/etc/pve/nodes/pve/lxc/110.conf")
    guest.parent.mkdir(parents=True, exist_ok=True)
    guest.write_text("net0: name=eth0,bridge=vmbr0,ip=192.168.68.50/22,gw=192.168.68.1\n")
    prompts = []
    replies = {
        "LVM-thin storage for sandboxes": iter(["fast", ""]),
        "Control-plane CT ID": iter(["590", "591"]),
        "Control-plane static IPv4 address": iter(["192.168.68.", "\xd1", ""]),
    }

    def answer(prompt=""):
        prompts.append(prompt)
        if "[y/N]" in prompt:
            return "y"
        for key, values in replies.items():
            if prompt.startswith(key):
                value = next(values)
                if value == "\xd1":
                    raise UnicodeDecodeError("utf-8", b"\xd1", 0, 1, "invalid continuation byte")
                return value
        return ""

    assert run([], input_fn=answer) == 0
    assert not any(p.startswith("Choose") for p in prompts)
    assert not any(p.startswith("LVM-thin storage") for p in prompts)
    assert not any(p.startswith("Control-plane CT ID") for p in prompts)
    assert any("Invalid address" in line for line in printed)
    assert any("Could not read that input" in line for line in printed)
    # .50 is a stopped guest's static address, so the suggestion skips it.
    assert any(p.startswith("Control-plane static IPv4 address [192.168.68.51]") for p in prompts)
    assert saved(runner).ct_ip == "192.168.68.51" and saved(runner).ct_id == 591



def test_interactive_install_offers_the_other_cluster_nodes(env, monkeypatch):
    from umiak_installer import nodes

    runner, run, printed = env
    added = []
    monkeypatch.setattr(nodes, "candidates", lambda runner, current: ["pve2", "pve3"])

    def add(runner, current, bundle, node, *, ui, confirmed=False):
        if node == "pve3":
            raise main.InstallerError("no LVM-thin storage")
        added.append(node)

    monkeypatch.setattr(nodes, "add_node", add)
    monkeypatch.setattr(nodes, "remember", lambda runner, current, path: current)
    prompts = []

    def answer(prompt=""):
        prompts.append(prompt)
        return "y" if "[y/N]" in prompt else ""

    assert run(FLAGS[2:], input_fn=answer) == 0
    assert "Add pve2 as a sandbox node? [Y/n]: " in prompts and added == ["pve2"]
    assert any("Could not add pve3: no LVM-thin storage" in line for line in printed)
    assert any("Add a sandbox node" in line for line in printed)
    assert printed[-3] == f"  https://umiak.tail0000.ts.net/claim#{CODE}"


def test_candidates_are_online_members_that_are_not_sandbox_nodes(tmp_path):
    from fake_pve import FakeRunner
    from umiak_installer import nodes

    runner = FakeRunner(tmp_path)

    class Console:
        def call(self, op):
            return {"nodes": [{"name": "pve"}]}

    assert nodes.candidates(runner, sample("complete"), console=Console()) == ["pve2"]


def test_lan_bridge_is_the_default_routes_bridge_and_reaches_the_ct(env, monkeypatch):
    from umiak_installer import pve

    runner, run, printed = env
    assert pve.lan_bridge(runner) == "vmbr0"
    runner.path("/sys/class/net/vmbr1/bridge").mkdir(parents=True)
    original = runner.run

    def routes_on_vmbr1(argv, input=None):
        if argv[:4] == ["ip", "-j", "route", "show"]:
            return json.dumps([{"dst": "default", "gateway": "192.168.68.1", "dev": "vmbr1"}])
        if argv[:5] == ["ip", "-j", "-4", "addr", "show"]:
            return json.dumps([{"ifname": "vmbr1", "addr_info": [{"local": "192.168.68.10", "prefixlen": 22}]}])
        return original(argv, input=input)

    monkeypatch.setattr(runner, "run", routes_on_vmbr1)
    assert pve.lan_bridge(runner) == "vmbr1"
    flags = [f for f in FLAGS if f not in ("--gateway-cidr", "192.168.68.1/22")]
    assert run(flags) == 0
    create = next(a for a in runner.commands if a[:2] == ["pct", "create"])
    assert "name=eth0,bridge=vmbr1,ip=192.168.68.50/22,gw=192.168.68.1" in create
    assert saved(runner).answers["bridge"] == "vmbr1"


def test_unknown_bridge_flag_is_a_usage_error(env):
    runner, run, printed = env
    assert run(FLAGS + ["--bridge", "vmbr9"]) == 2
    assert any("No Linux bridge named vmbr9" in line for line in printed)
    assert runner.mutations() == []


def test_custom_subnet_reaches_sdn_stack_and_node_agent(env):
    runner, run, printed = env
    assert run(FLAGS + ["--guest-subnet", "172.20.8.0/24", "--vmid-range", "710-799"]) == 0
    subnet = runner.objects["/cluster/sdn/vnets/umiak0/subnets/umiak-172.20.8.0-24"]
    assert subnet["gateway"] == "172.20.8.1"
    assert subnet["dhcp-range"] == "start-address=172.20.8.100,end-address=172.20.8.250"
    install = json.loads(runner.path("/var/lib/umiak-installer/secrets/install.json").read_text())
    assert install["network"]["guestSubnet"] == "172.20.8.0/24"
    assert install["limits"]["vmidMax"] == 799
    assert 'guestSubnet = "172.20.8.0/24"' in runner.path("/etc/umiak-node.toml").read_text()
