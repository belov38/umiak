import hashlib
import json

import pytest

from fake_ct import AGENT, CtFake
from test_menu import FLAGS
from test_stack import make_bundle
from umiak_installer import day2, main, prepare_host, state
from umiak_installer.pve import CommandError, InstallerError

SIGNIN = "ABCD-EFGH-2345-7723-WXYZ-MNOP"
RECOVERED = "NewClaimCode_abcdefghijklmnopqrstuvwxyz012"


class FakeUi:
    def __init__(self, answers=None, yes=False, interactive=True):
        self.answers = list(answers or [])
        self.prompts = []
        self.said = []
        self.yes = yes
        self.interactive = interactive

    def say(self, line):
        self.said.append(line)

    def _next(self, prompt):
        self.prompts.append(prompt)
        return self.answers.pop(0) if self.answers else ""

    def confirm(self, prompt):
        return self.yes or self._next(prompt).strip().lower() in ("y", "yes")

    def typed(self, prompt, word):
        return self.yes or self._next(prompt).strip() == word


class Day2Fake(CtFake):
    def _in_ct(self, argv, input):
        if argv[:2] == ["docker", "compose"] and "exec" in argv:
            if "umiak-signin" in argv:
                return f"/signin#{SIGNIN}\nExpires: 2026-11-04T10:10:00.000Z. Existing sessions remain valid."
            if any(part.endswith("recover.mjs") for part in argv):
                return (f"New one-time owner setup code: {RECOVERED}\n"
                        "All previous owner sessions and CLI pairings have been revoked. Claim in the dashboard.")
        return super()._in_ct(argv, input)


@pytest.fixture
def installed(tmp_path):
    runner = Day2Fake(tmp_path / "host")
    bundle = make_bundle(tmp_path / "bundle")
    (bundle.root / "node-agent.sha256").write_text(hashlib.sha256(AGENT).hexdigest() + "\n")
    assert main.main(FLAGS, runner=runner, bundle=bundle, out=lambda _: None, sleep=lambda _: None) == 0
    runner.commands.clear()
    runner.pushed.clear()
    return runner, load(runner), tmp_path


def load(runner):
    return state.load(runner.path(str(state.DEFAULT_PATH)))


def new_bundle(tmp_path, agent=AGENT, version="1.3.0"):
    bundle = make_bundle(tmp_path / ("bundle-" + version), version=version)
    (bundle.root / "node-agent.sha256").write_text(hashlib.sha256(agent).hexdigest() + "\n")
    return bundle


def touches_node_agent(runner):
    # The host report's read-only version probe is not an install.
    return any(a[:2] == ["pct", "pull"] for a in runner.commands) or any(
        a[:2] == ["docker", "create"] for a in runner.ct_commands())


# --- update ---------------------------------------------------------------

def test_update_with_unchanged_node_agent_does_not_touch_the_node(installed):
    runner, current, tmp_path = installed
    keys_before = runner.path(prepare_host.AUTHORIZED_KEYS).read_text()
    binary_mtime = runner.path(prepare_host.NODE_BINARY).stat().st_mtime_ns
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert not touches_node_agent(runner)
    assert runner.path(prepare_host.AUTHORIZED_KEYS).read_text() == keys_before
    assert runner.path(prepare_host.NODE_BINARY).stat().st_mtime_ns == binary_mtime
    assert load(runner).release == "1.3.0" and load(runner).phase == "complete"
    env = runner.pushed["/opt/umiak/.env"].decode()
    assert "UMIAK_VERSION=1.3.0" in env


def test_update_with_changed_node_agent_reinstalls_it(installed):
    runner, current, tmp_path = installed
    runner.path(prepare_host.NODE_BINARY).write_bytes(b"old-agent")
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert touches_node_agent(runner)
    assert runner.path(prepare_host.NODE_BINARY).read_bytes() == AGENT


def test_update_rewrites_network_install_json_and_secrets_then_restarts_quickstart(installed):
    runner, current, tmp_path = installed
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert json.loads(runner.pushed["/root/.umiak-staging/install.json"])["release"] == "1.3.0"
    assert "/root/.umiak-staging/quickstart-network.json" in runner.pushed
    inside = runner.ct_commands()
    pull = next(n for n, a in enumerate(inside) if a[:2] == ["docker", "compose"] and "pull" in a)
    up = next(n for n, a in enumerate(inside) if a[:2] == ["docker", "compose"] and "up" in a)
    restart = next(n for n, a in enumerate(inside) if a[:2] == ["docker", "compose"] and "restart" in a)
    assert pull < up < restart and "quickstart" in inside[restart]
    # Data volumes are never removed by an update.
    assert not any("-v" in a and "down" in a for a in inside)
    assert not any(a[:3] == ["docker", "volume", "rm"] for a in inside)


def test_update_keeps_ct_ip_in_ipset_and_drops_only_stale_umiak_entries(installed):
    runner, current, tmp_path = installed
    ipset = runner.objects["/cluster/firewall/ipset/umiak-gateway"]
    ipset.clear()
    ipset.append({"cidr": "192.168.68.40", "comment": "Umiak guest gateway"})
    ipset.append({"cidr": "192.168.68.41", "comment": "added by admin"})
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    cidrs = sorted(row["cidr"] for row in runner.objects["/cluster/firewall/ipset/umiak-gateway"])
    assert cidrs == ["192.168.68.41", "192.168.68.50"]


def test_update_refuses_on_another_node(installed):
    runner, current, tmp_path = installed
    runner._hostname = "pve2"
    with pytest.raises(InstallerError, match="pve"):
        day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert runner.mutations() == [] and not runner.ct_commands()


# --- sign in --------------------------------------------------------------

def test_signin_prints_a_signin_link_on_the_tailnet_origin(installed):
    runner, current, _ = installed
    ui = FakeUi()
    link = day2.signin(runner, current, ui=ui)
    assert link == f"https://umiak.tail0000.ts.net/signin#{SIGNIN}"
    command = next(a for a in runner.ct_commands() if "umiak-signin" in a)
    assert command[-5:] == ["exec", "-T", "quickstart", "umiak-signin", "--link"]


def test_signin_reports_the_outstanding_codes_limit(installed):
    runner, current, _ = installed
    message = "10 sign-in codes are already outstanding. Wait for one to expire."
    original = runner.run

    def limited(argv, input=None):
        if "umiak-signin" in argv:
            raise CommandError(list(argv), 2, message, "")
        return original(argv, input)

    runner.run = limited
    with pytest.raises(InstallerError, match="outstanding"):
        day2.signin(runner, current, ui=FakeUi())


# --- reset owner ----------------------------------------------------------

def test_reset_owner_without_typed_reset_does_nothing(installed):
    runner, current, _ = installed
    ui = FakeUi(answers=["reset"])
    assert day2.reset_owner(runner, current, ui=ui) is None
    assert not runner.ct_commands() and runner.mutations() == []
    assert any("revoke" in line.lower() for line in ui.said + ui.prompts)


def test_reset_owner_with_typed_reset_prints_a_new_claim_link(installed):
    runner, current, _ = installed
    link = day2.reset_owner(runner, current, ui=FakeUi(answers=["RESET"]))
    assert link == f"https://umiak.tail0000.ts.net/claim#{RECOVERED}"
    command = next(a for a in runner.ct_commands() if any(p.endswith("recover.mjs") for p in a))
    assert command[:7] == ["docker", "compose", "--project-directory", "/opt/umiak", "exec", "-T", "quickstart"]


# --- uninstall ------------------------------------------------------------

def add_pool_members(runner, *members):
    runner.objects["/pools/umiak"]["members"] = [
        {"vmid": vmid, "type": kind, "node": "pve", "status": status, "id": f"{kind}/{vmid}"}
        for vmid, kind, status in members
    ]
    for vmid, kind, _ in members:
        runner.objects[f"/nodes/pve/{kind}/{vmid}"] = {}


def test_uninstall_without_pve_objects_never_calls_pveum_or_pvesh_delete(installed):
    runner, current, _ = installed
    add_pool_members(runner, (510, "qemu", "running"))
    ui = FakeUi(answers=["y"])
    day2.uninstall(runner, current, remove_pve_objects=False, remove_guests=False, ui=ui)
    assert not any(a[0] == "pveum" for a in runner.commands)
    assert not any(a[:2] == ["pvesh", "delete"] for a in runner.commands)
    assert ["pct", "destroy", "591", "--purge", "1"] in runner.commands
    assert load(runner) is None
    # The guest was left alone and the PVE objects remain.
    assert "/nodes/pve/qemu/510" in runner.objects and "/cluster/sdn/zones/umiak" in runner.objects


def test_uninstall_is_cancelled_without_confirmation(installed):
    runner, current, _ = installed
    with pytest.raises(InstallerError, match="Cancelled"):
        day2.uninstall(runner, current, remove_pve_objects=False, remove_guests=False, ui=FakeUi(answers=["n"]))
    assert not any(a[:2] in (["pct", "stop"], ["pct", "destroy"]) for a in runner.commands)


def test_uninstall_refuses_a_pool_member_outside_umiak_ranges(installed):
    runner, current, _ = installed
    add_pool_members(runner, (510, "qemu", "running"), (102, "qemu", "running"))
    with pytest.raises(InstallerError, match="102"):
        day2.uninstall(runner, current, remove_pve_objects=False, remove_guests=True, ui=FakeUi(answers=["DELETE"]))
    assert runner.mutations() == []
    assert not any(a[0] == "pct" and a[1] in ("stop", "destroy") for a in runner.commands)


def test_uninstall_refuses_to_remove_objects_while_the_pool_has_guests(installed):
    runner, current, _ = installed
    add_pool_members(runner, (600, "qemu", "stopped"))
    with pytest.raises(InstallerError, match="pool umiak"):
        day2.uninstall(runner, current, remove_pve_objects=True, remove_guests=False, ui=FakeUi(answers=["DELETE"]))
    assert runner.mutations() == []


def test_uninstall_refuses_a_ct_not_tagged_umiak(installed):
    runner, current, _ = installed
    row = next(r for r in runner.objects["/cluster/resources"] if r["vmid"] == 591)
    row["tags"] = "home"
    with pytest.raises(InstallerError, match="591"):
        day2.uninstall(runner, current, remove_pve_objects=False, remove_guests=False, ui=FakeUi(answers=["y"]))
    assert not any(a[0] == "pct" and a[1] in ("stop", "destroy") for a in runner.commands)


def test_full_uninstall_removes_only_umiak_objects(installed):
    runner, current, _ = installed
    add_pool_members(runner, (510, "qemu", "running"), (600, "qemu", "stopped"))
    keys = runner.path(prepare_host.AUTHORIZED_KEYS)
    assert 'command="/usr/local/bin/umiak-node --stdio"' in keys.read_text()
    runner.acls.append({"path": "/", "ugid": "admin@pam", "roleid": "Administrator"})
    runner.roles.append({"roleid": "HomeRole", "privs": "VM.Audit"})
    ui = FakeUi(answers=["DELETE"])
    day2.uninstall(runner, current, remove_pve_objects=True, remove_guests=True, ui=ui)

    # Guests: running one stopped first, both destroyed; the foreign VM 103 untouched.
    assert ["pvesh", "create", "/nodes/pve/qemu/510/status/stop"] in runner.commands
    assert not any(a[:3] == ["pvesh", "create", "/nodes/pve/qemu/600/status/stop"] for a in runner.commands)
    destroyed = [a[2] for a in runner.commands if a[:2] == ["pvesh", "delete"] and a[2].startswith("/nodes/")]
    assert destroyed == ["/nodes/pve/qemu/510", "/nodes/pve/qemu/600"]
    assert any(r["vmid"] == 103 for r in runner.objects["/cluster/resources"])

    # PVE objects gone, SDN applied after zone removal; foreign role and ACL kept.
    for path in ["/cluster/sdn/zones/umiak", "/cluster/sdn/vnets/umiak0", "/cluster/firewall/ipset/umiak-gateway",
                 "/cluster/firewall/groups/umiak-egress", "/pools/umiak"]:
        assert path not in runner.objects, path
    assert [r["roleid"] for r in runner.roles] == ["HomeRole"]
    assert runner.users == [] and runner.tokens == []
    assert {"path": "/", "ugid": "admin@pam", "roleid": "Administrator"} in runner.acls
    zone = next(n for n, a in enumerate(runner.commands) if a == ["pvesh", "delete", "/cluster/sdn/zones/umiak"])
    apply = max(n for n, a in enumerate(runner.commands) if a == ["pvesh", "set", "/cluster/sdn"])
    assert zone < apply

    # Node files: forced-command line removed, other key lines kept.
    assert keys.read_text() == "ssh-rsa AAAA existing-management-key\n"
    assert not runner.path(prepare_host.NODE_BINARY).exists()
    assert not runner.path(prepare_host.NODE_CONFIG).exists()
    assert not runner.path("/etc/pve/umiak").exists()
    assert not runner.path(prepare_host.STATE_DIR).exists()
    # Every destructive step was listed before the typed confirmation.
    listing = "\n".join(ui.said)
    for word in ["591", "510", "600", "umiak@pve", "umiak-gateway", "umiak0", "authorized_keys"]:
        assert word in listing, word


def test_full_uninstall_needs_typed_delete(installed):
    runner, current, _ = installed
    with pytest.raises(InstallerError, match="Cancelled"):
        day2.uninstall(runner, current, remove_pve_objects=True, remove_guests=False, ui=FakeUi(answers=["y"]))
    assert runner.mutations() == []
    assert not any(a[0] == "pct" and a[1] in ("stop", "destroy") for a in runner.commands)


def test_uninstall_refuses_with_foreign_pending_sdn_changes(installed):
    runner, current, _ = installed
    runner.objects["/cluster/sdn/zones"].append({"zone": "home", "state": "new"})
    with pytest.raises(InstallerError, match="SDN"):
        day2.uninstall(runner, current, remove_pve_objects=True, remove_guests=False, ui=FakeUi(answers=["DELETE"]))
    assert runner.mutations() == []


# --- menu wiring ----------------------------------------------------------

def test_menu_dispatches_signin_non_interactively(installed, capsys):
    runner, current, tmp_path = installed
    printed = []
    code = main.main(["--non-interactive", "--action", "signin"], runner=runner, bundle=new_bundle(tmp_path),
                     out=printed.append, sleep=lambda _: None)
    assert code == 0
    assert printed[-1] == f"Open https://umiak.tail0000.ts.net/signin#{SIGNIN}"


def test_menu_uninstall_non_interactive_needs_yes(installed):
    runner, current, tmp_path = installed
    printed = []
    code = main.main(["--non-interactive", "--action", "uninstall"], runner=runner, bundle=new_bundle(tmp_path),
                     out=printed.append, sleep=lambda _: None)
    assert code == 2
    assert not any(a[0] == "pct" and a[1] in ("stop", "destroy") for a in runner.commands)


def test_menu_update_downloads_the_latest_release_and_records_it(installed):
    runner, current, tmp_path = installed
    fetched = []

    def download(version, dest):
        fetched.append((version, dest))
        return new_bundle(tmp_path, version=version)

    printed = []
    code = main.main(["--non-interactive", "--action", "update"], runner=runner, bundle=new_bundle(tmp_path, version="1.2.3"),
                     out=printed.append, sleep=lambda _: None, download=download, latest=lambda: "1.4.0")
    assert code == 0, printed
    assert fetched == [("1.4.0", runner.path(prepare_host.STATE_DIR) / "releases")]
    assert load(runner).release == "1.4.0" and printed[-1] == "Umiak is updated to 1.4.0."


def test_menu_reset_owner_interactive_requires_reset(installed):
    runner, current, tmp_path = installed
    answers = iter(["3", "yes"])
    printed = []
    code = main.main([], runner=runner, bundle=new_bundle(tmp_path), out=printed.append, sleep=lambda _: None,
                     input_fn=lambda prompt="": next(answers))
    assert code == 1
    assert not any(any(p.endswith("recover.mjs") for p in a) for a in runner.ct_commands())
