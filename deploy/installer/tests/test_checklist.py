from fake_pve import FakeRunner
from umiak_installer import checklist


def by_name(checks):
    return {check.name: check for check in checks}


def test_pve_like_host_is_all_ok(tmp_path):
    checks = checklist.inspect(FakeRunner(tmp_path))
    assert [c.name for c in checks if not c.ok] == []
    assert {c.name for c in checks} == {
        "root", "pve-version", "cluster-quorum", "python", "lvmthin-storage", "media-storage",
        "dnsmasq", "ip-forward", "cluster-firewall", "sdn-pending", "free-vmids", "pveproxy-cert",
    }


def test_missing_dnsmasq_and_forwarding_have_exact_fixes(tmp_path):
    checks = by_name(checklist.inspect(FakeRunner(tmp_path, dnsmasq=False, ip_forward="0")))
    failed = sorted(name for name, check in checks.items() if not check.ok)
    assert failed == ["dnsmasq", "ip-forward"]
    assert checks["dnsmasq"].fix.commands == [
        ["apt-get", "install", "-y", "dnsmasq", "dnsmasq-utils"],
        ["systemctl", "disable", "--now", "dnsmasq"],
    ]
    forward = checks["ip-forward"].fix
    assert forward.files == {"/etc/sysctl.d/99-umiak.conf": "net.ipv4.ip_forward = 1\n"}
    assert forward.commands == [["sysctl", "--system"]]


def test_apply_fix_writes_files_then_runs_commands(tmp_path):
    runner = FakeRunner(tmp_path, ip_forward="0")
    fix = by_name(checklist.inspect(runner))["ip-forward"].fix
    checklist.apply_fix(runner, fix)
    assert runner.path("/etc/sysctl.d/99-umiak.conf").read_text() == "net.ipv4.ip_forward = 1\n"
    assert runner.commands[-1] == ["sysctl", "--system"]


def test_disabled_firewall_fix_warns(tmp_path):
    check = by_name(checklist.inspect(FakeRunner(tmp_path, firewall=0)))["cluster-firewall"]
    assert not check.ok
    assert check.fix.commands == [["pvesh", "set", "/cluster/firewall/options", "--enable", "1"]]
    assert "all nodes" in check.fix.description


def test_hard_failures_have_no_fix(tmp_path):
    runner = FakeRunner(
        tmp_path, euid=1000, version="8.4.1", quorate=0,
        guests=[{"vmid": 510, "type": "qemu", "name": "someone-else"}],
    )
    runner.objects["/cluster/sdn/zones"] = [{"zone": "foreign", "state": "new"}]
    checks = by_name(checklist.inspect(runner))
    for name in ["root", "pve-version", "cluster-quorum", "sdn-pending", "free-vmids"]:
        assert not checks[name].ok, name
        assert checks[name].fix is None, name
    assert "510" in checks["free-vmids"].detail


def test_umiak_guests_in_ranges_are_allowed(tmp_path):
    runner = FakeRunner(tmp_path, guests=[{"vmid": 600, "type": "qemu", "name": "umiak-tpl-linux", "tags": "umiak"}])
    assert by_name(checklist.inspect(runner))["free-vmids"].ok


def test_enabled_dnsmasq_service_fails_with_disable_fix(tmp_path):
    check = by_name(checklist.inspect(FakeRunner(tmp_path, dnsmasq_enabled=True)))["dnsmasq"]
    assert not check.ok
    assert check.fix.commands == [["systemctl", "disable", "--now", "dnsmasq"]]


def test_custom_pveproxy_certificate_is_refused_without_fix(tmp_path):
    runner = FakeRunner(tmp_path)
    pem = runner.path(f"/etc/pve/nodes/{runner.hostname()}/pveproxy-ssl.pem")
    pem.parent.mkdir(parents=True, exist_ok=True)
    pem.write_text("-----BEGIN CERTIFICATE-----\n")
    check = by_name(checklist.inspect(runner))["pveproxy-cert"]
    assert not check.ok
    assert check.fix is None
    assert check.detail == (
        "This node serves a custom certificate (pveproxy-ssl.pem). Umiak 0.1 needs the default Proxmox "
        "certificate on port 8006; custom/ACME certificates are not supported yet."
    )

