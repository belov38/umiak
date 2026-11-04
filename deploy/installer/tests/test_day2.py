import hashlib
import json

import pytest

from fake_ct import AGENT, TS_STATUS, CtFake
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
    def __init__(self, root, **kwargs):
        super().__init__(root, **kwargs)
        self.destroy_error = None  # qm destroy fails with this stderr
        self.stuck = set()  # vmids qm destroy reports success for but leaves behind
        self.lvs = []  # rows like `lvs --reportformat json` prints
        self.ct_net0 = "name=eth0,bridge=vmbr0,ip=192.168.68.50/22,gw=192.168.68.1"

    def run(self, argv, input=None):
        argv = list(argv)
        if argv[0] == "lvs":
            self.commands.append(argv)
            return json.dumps({"report": [{"lv": [row for row in self.lvs if row["vg_name"] == argv[-1]]}]})
        if argv[0] == "lvremove":
            self.commands.append(argv)
            vg, name = argv[-1].split("/")
            self.lvs = [row for row in self.lvs if (row["vg_name"], row["lv_name"]) != (vg, name)]
            return ""
        if argv[:2] == ["qm", "stop"]:
            self.commands.append(argv)
            return ""
        if argv[:2] == ["qm", "destroy"]:
            self.commands.append(argv)
            if self.destroy_error:
                raise CommandError(argv, 255, "", self.destroy_error)
            vmid = int(argv[2])
            if vmid not in self.stuck:
                resources = self.objects["/cluster/resources"]
                resources[:] = [row for row in resources if int(row["vmid"]) != vmid]
                self.lvs = [row for row in self.lvs if not row["lv_name"].startswith(f"vm-{vmid}-disk-")]
            return ""
        if argv[:2] == ["pct", "config"]:
            self.commands.append(argv)
            return f"arch: amd64\nhostname: umiak-cp\nnet0: {self.ct_net0}\nostype: debian\n"
        return super().run(argv, input)

    def _in_ct(self, argv, input):
        if any(part.endswith("/nodes.mjs") or part.startswith("// Umiak node inventory") for part in argv):
            return json.dumps({"nodes": [{"name": "pve", "nodeId": "node", "storage": "local-lvm", "ramCapMb": 8192}]})
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
    for vmid, kind, status in members:
        runner.objects[f"/nodes/pve/{kind}/{vmid}"] = {}
        runner.objects[f"/nodes/pve/{kind}/{vmid}/status/current"] = {"status": status}
        runner.objects["/cluster/resources"].append({"vmid": vmid, "type": kind, "node": "pve", "pool": "umiak"})


def lv(name, tags="umiak", vg="pve", pool="data"):
    return {"lv_name": name, "vg_name": vg, "pool_lv": pool, "lv_tags": tags}


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
    assert ["qm", "stop", "510"] in runner.commands
    assert ["qm", "stop", "600"] not in runner.commands
    destroyed = [a for a in runner.commands if a[:2] == ["qm", "destroy"]]
    assert destroyed == [["qm", "destroy", v, "--purge", "1", "--destroy-unreferenced-disks", "0"]
                         for v in ("510", "600")]
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
    assert f"  https://umiak.tail0000.ts.net/signin#{SIGNIN}" in printed


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


def test_uninstall_with_guests_removes_umiak_snapshot_lvs_by_full_name_only(installed):
    runner, current, _ = installed
    add_pool_members(runner, (510, "qemu", "stopped"))
    runner.lvs = [
        lv("vm-510-disk-0", "umiak,umiak-vm-510"),
        lv("umiak-snap-abc123-root", "umiak,umiak-snap-abc123,umiak-src-510"),
        lv("vm-520-disk-0", "umiak,umiak-vm-520"),  # orphan disk of a gone Umiak guest
        lv("umiak-snap-mine-root", "home"),  # similar name, no umiak tag
        lv("vm-103-disk-0", "umiak"),  # tagged but outside the Umiak ranges
        lv("umiak-snap-other-root", "umiak", pool="other"),  # another thin pool
        lv("root", ""),
        lv("data", ""),
    ]
    ui = FakeUi(answers=["DELETE"])
    day2.uninstall(runner, current, remove_pve_objects=False, remove_guests=True, ui=ui)
    removed = [a[-1] for a in runner.commands if a[0] == "lvremove"]
    assert removed == ["pve/umiak-snap-abc123-root", "pve/vm-520-disk-0"]
    assert all(a[:2] == ["lvremove", "-y"] and "@" not in a[-1] for a in runner.commands if a[0] == "lvremove")
    assert sorted(row["lv_name"] for row in runner.lvs) == ["data", "root", "umiak-snap-mine-root",
                                                            "umiak-snap-other-root", "vm-103-disk-0"]
    listing = "\n".join(ui.said)
    assert "pve/umiak-snap-abc123-root" in listing and "pve/vm-520-disk-0" in listing
    assert "umiak-snap-mine-root" not in listing


def test_uninstall_stops_a_guest_that_started_after_the_plan(installed):
    runner, current, _ = installed
    add_pool_members(runner, (510, "qemu", "stopped"))
    runner.objects["/nodes/pve/qemu/510/status/current"] = {"status": "running"}
    day2.uninstall(runner, current, remove_pve_objects=False, remove_guests=True, ui=FakeUi(answers=["DELETE"]))
    stop = runner.commands.index(["qm", "stop", "510"])
    delete = next(n for n, a in enumerate(runner.commands) if a[:3] == ["qm", "destroy", "510"])
    assert stop < delete


def test_uninstall_surfaces_a_failed_destroy_and_keeps_the_pool(installed):
    runner, current, _ = installed
    add_pool_members(runner, (600, "qemu", "stopped"))
    runner.destroy_error = "no such logical volume vmdata/data"
    with pytest.raises(CommandError):
        day2.uninstall(runner, current, remove_pve_objects=True, remove_guests=True, ui=FakeUi(answers=["DELETE"]))
    assert not any(a[:3] == ["pveum", "pool", "delete"] for a in runner.commands)


def test_uninstall_blocks_pool_removal_while_a_vm_remains(installed):
    runner, current, _ = installed
    add_pool_members(runner, (600, "qemu", "stopped"), (601, "qemu", "stopped"))
    runner.stuck = {601}
    with pytest.raises(InstallerError, match="601"):
        day2.uninstall(runner, current, remove_pve_objects=True, remove_guests=True, ui=FakeUi(answers=["DELETE"]))
    assert not any(a[:3] == ["pveum", "pool", "delete"] for a in runner.commands)
    assert "/pools/umiak" in runner.objects


def test_full_uninstall_removes_zone_dnsmasq_leftovers_after_sdn_apply(installed):
    runner, current, _ = installed
    for name in day2.DNSMASQ_FILES:
        runner.path(name).parent.mkdir(parents=True, exist_ok=True)
        runner.path(name).write_text("x")
    other = runner.path("/etc/dnsmasq.d/home.conf")
    other.parent.mkdir(parents=True, exist_ok=True)
    other.write_text("keep")
    (runner.path("/etc/dnsmasq.d/umiak")).mkdir(parents=True, exist_ok=True)
    ui = FakeUi(answers=["DELETE"])
    day2.uninstall(runner, current, remove_pve_objects=True, remove_guests=False, ui=ui)
    assert not any(runner.path(n).exists() for n in day2.DNSMASQ_FILES + day2.DNSMASQ_DIRS)
    assert other.read_text() == "keep"
    apply = max(n for n, a in enumerate(runner.commands) if a == ["pvesh", "set", "/cluster/sdn"])
    disable = runner.commands.index(["systemctl", "disable", "--now", "dnsmasq@umiak"])
    reload = runner.commands.index(["systemctl", "reload", "dbus"])
    assert apply < disable < reload
    assert "dnsmasq.umiak.leases" in "\n".join(ui.said)


def test_update_waits_for_tailscaled_after_starting_the_ct(installed):
    runner, current, tmp_path = installed
    starting = {"BackendState": "Starting"}
    runner.ts_states = [starting, starting, TS_STATUS]
    sleeps = []
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=sleeps.append)
    assert ["pct", "start", "591"] in runner.commands
    assert sleeps[:2] == [2, 2]


def test_update_fails_clearly_when_tailscaled_never_runs(installed):
    runner, current, tmp_path = installed
    runner.ts_states = [{"BackendState": "Stopped"}]
    with pytest.raises(InstallerError, match="not running"):
        day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert not any(a[:2] == ["docker", "compose"] for a in runner.ct_commands())


def test_update_refuses_when_the_ct_address_changed(installed):
    runner, current, tmp_path = installed
    runner.ct_net0 = "name=eth0,bridge=vmbr0,ip=192.168.68.60/22,gw=192.168.68.1"
    with pytest.raises(InstallerError, match="192.168.68.60.*192.168.68.50"):
        day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert runner.mutations() == [] and not runner.ct_commands()
    runner.ct_net0 = "name=eth0,bridge=vmbr0,ip=dhcp"
    with pytest.raises(InstallerError, match="installed with 192.168.68.50"):
        day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)


@pytest.mark.parametrize("interactive,answer,expected", [(True, "y", False), (True, "DELETE", True), (False, None, True)])
def test_yes_skips_typed_words_only_non_interactive(interactive, answer, expected):
    prompts = []

    def ask(prompt=""):
        prompts.append(prompt)
        return answer

    ui = main.Ui(interactive=interactive, yes=True, input_fn=ask, out=lambda _: None)
    assert ui.typed("Type DELETE to continue", "DELETE") is expected
    assert bool(prompts) is interactive


def test_update_scopes_an_unscoped_zone_and_leaves_scoped_ones(installed):
    runner, current, tmp_path = installed
    zone = runner.objects[prepare_host.ZONE]
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert not any(a[:3] == ["pvesh", "set", prepare_host.ZONE] for a in runner.commands)
    zone.pop("nodes")
    runner.commands.clear()
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert zone["nodes"] == "pve"
    assert runner.commands.count(["pvesh", "set", "/cluster/sdn"]) == 1


def test_update_does_not_restore_a_retired_control_plane_hosts_sandbox_role(installed, monkeypatch):
    from umiak_installer import nodes

    runner, current, tmp_path = installed
    zone = runner.objects[prepare_host.ZONE]
    zone["nodes"] = "pve2"
    monkeypatch.setattr(nodes.NodeConsole, "call", lambda *_args, **_kwargs: {"nodes": []})
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert zone["nodes"] == "pve2"
    assert not any(a[:3] == ["pvesh", "set", prepare_host.ZONE] for a in runner.commands)
    assert not any(a[-1:] == ["--stdio"] for a in runner.commands)

def test_update_repairs_private_dnsmasq_configs_and_verifies_the_unit(installed):
    runner, current, tmp_path = installed
    conf = runner.path("/etc/dnsmasq.d/umiak/umiak0.conf")
    conf.parent.mkdir(parents=True)
    conf.write_text("x")
    conf.chmod(0o600)
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert conf.stat().st_mode & 0o777 == 0o644
    for argv in (["systemctl", "reload", "dbus"], ["systemctl", "restart", "dnsmasq@umiak"],
                 ["systemctl", "is-active", "dnsmasq@umiak"]):
        assert argv in runner.commands


def test_update_fails_when_dnsmasq_unit_is_down(installed):
    runner, current, tmp_path = installed
    runner.dnsmasq_unit_active = False
    with pytest.raises(InstallerError, match="dnsmasq@umiak"):
        day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)


def test_retired_original_host_update_preserves_media_facts_without_local_media(installed, monkeypatch):
    from umiak_installer import nodes

    runner, current, tmp_path = installed
    facts = runner.path(day2.SECRETS_DIR) / "install.json"
    saved = json.loads(facts.read_text())
    saved["limits"]["mediaStorage"] = "historic-media"
    facts.write_text(json.dumps(saved))
    monkeypatch.setattr(nodes.NodeConsole, "call", lambda *_args, **_kwargs: {"nodes": []})
    monkeypatch.setattr(day2, "media_storages", lambda *_args: [])
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    assert json.loads(facts.read_text())["limits"]["mediaStorage"] == "historic-media"


# --- image pruning --------------------------------------------------------

def test_update_prunes_old_umiak_images_keeping_new_and_previous(installed):
    runner, current, tmp_path = installed
    prev = current.release
    runner.images = [f"ghcr.io/belov38/umiak-api:{prev}", "ghcr.io/belov38/umiak-api:1.3.0",
                     "ghcr.io/belov38/umiak-api:0.0.1", "ghcr.io/belov38/umiak-web:0.0.1",
                     "ghcr.io/belov38/umiak-web:0.0.2", "postgres:0.0.1", "node:22", "ghcr.io/other/umiak-x:0.0.1"]
    runner.images_in_use = {"ghcr.io/belov38/umiak-web:0.0.2"}
    ui = FakeUi()
    day2.update(runner, current, new_bundle(tmp_path), ui=ui, sleep=lambda _: None)
    assert sorted(runner.images) == sorted([f"ghcr.io/belov38/umiak-api:{prev}", "ghcr.io/belov38/umiak-api:1.3.0",
                                            "ghcr.io/belov38/umiak-web:0.0.2", "postgres:0.0.1", "node:22",
                                            "ghcr.io/other/umiak-x:0.0.1"])
    inside = runner.ct_commands()
    assert ["docker", "image", "prune", "-f"] in inside
    assert any("Removed 2 old Umiak image(s)" in line for line in ui.said)


def test_update_brings_up_the_stack_with_remove_orphans(installed):
    runner, current, tmp_path = installed
    day2.update(runner, current, new_bundle(tmp_path), ui=FakeUi(), sleep=lambda _: None)
    ups = [a for a in runner.ct_commands() if a[:2] == ["docker", "compose"] and "up" in a]
    assert ups and all("--remove-orphans" in a for a in ups)
