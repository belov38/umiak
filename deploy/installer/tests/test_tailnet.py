import pytest

from fake_ct import TS_STATUS, CtFake
from umiak_installer import stack, tailnet
from umiak_installer.pve import InstallerError


@pytest.fixture
def runner(tmp_path):
    return CtFake(tmp_path / "host")


def test_require_https_without_cert_domains_points_to_admin_console():
    with pytest.raises(tailnet.TailnetNotReady, match="https://login.tailscale.com/admin/dns"):
        tailnet.require_https({"BackendState": "Running", "TailscaleIPs": ["100.64.10.20"]})
    with pytest.raises(tailnet.TailnetNotReady):
        tailnet.require_https({"BackendState": "Running", "CertDomains": []})
    assert str(tailnet.TailnetNotReady.MESSAGE) == (
        "Enable MagicDNS and HTTPS certificates: https://login.tailscale.com/admin/dns")


def test_info_from_status():
    info = tailnet.parse({"CertDomains": ["umiak.tail0000.ts.net"], "TailscaleIPs": ["100.64.10.20"]})
    assert info == tailnet.TailnetInfo("umiak.tail0000.ts.net", "100.64.10.20")
    # IPv6 first, DNS name from Self when certificates are not enabled yet.
    info = tailnet.parse({"TailscaleIPs": ["fd7a:115c:a1e0::1", "100.64.10.20"], "Self": {"DNSName": "umiak.x.ts.net."}})
    assert info == tailnet.TailnetInfo("umiak.x.ts.net", "100.64.10.20")


def test_install_json_uses_tailnet_identity():
    info = tailnet.parse({"CertDomains": ["umiak.tail0000.ts.net"], "TailscaleIPs": ["100.64.10.20"]})
    data = stack.install_json(
        release="1.2.3", node="pve", node_ip="192.168.68.10", fingerprint="ab" * 32, ct_ip="192.168.68.50",
        guest_dns="1.1.1.1", tailnet_dns=info.dns_name, tailnet_ip=info.ipv4, limits={},
    )
    assert data["network"]["previewDomain"] == "umiak.100-64-10-20.sslip.io"
    assert data["network"]["sshHost"] == "100.64.10.20"
    assert data["publicUrl"] == "https://umiak.tail0000.ts.net"


def test_up_prints_login_link_and_waits_for_running(runner):
    printed = []
    runner.ts_states = [
        {"BackendState": "NoState"},
        {"BackendState": "NeedsLogin", "AuthURL": "https://login.tailscale.com/a/abc123"},
        {"BackendState": "NeedsLogin", "AuthURL": "https://login.tailscale.com/a/abc123"},
        TS_STATUS,
    ]
    info = tailnet.up(runner, 591, "umiak", out=printed.append, sleep=lambda _: None)
    assert info == tailnet.TailnetInfo("umiak.tail0000.ts.net", "100.64.10.20")
    up = next(a for a in runner.ct_commands() if a[:2] == ["tailscale", "up"])
    assert "--hostname=umiak" in up and "--accept-dns=false" in up
    # The login link is printed once, not on every poll.
    assert sum("https://login.tailscale.com/a/abc123" in line for line in printed) == 1


def test_up_tolerates_login_timeout_from_tailscale_up(runner):
    runner.fail_on = lambda argv: "tailscale" in argv and "up" in argv
    runner.ts_states = [TS_STATUS]
    assert tailnet.up(runner, 591, "umiak", out=lambda _: None, sleep=lambda _: None).ipv4 == "100.64.10.20"


def test_up_rejects_bad_hostname(runner):
    with pytest.raises(InstallerError, match="hostname"):
        tailnet.up(runner, 591, "--evil", out=lambda _: None, sleep=lambda _: None)


def test_serve_runs_https_proxy_to_trusted_listener(runner):
    tailnet.serve(runner, 591)
    assert ["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:4181"] in runner.ct_commands()


def test_claim_link_format():
    assert tailnet.claim_link("umiak.tail0000.ts.net", "Ab+c/d") == "https://umiak.tail0000.ts.net/claim#Ab%2Bc%2Fd"
