import pytest

from fake_ct import CtFake
from umiak_installer import ct
from umiak_installer.pve import InstallerError

SPEC = ct.CtSpec(id=591, ip="192.168.68.50", cidr=22, gw="192.168.68.1", storage="local-lvm")
CREATE = [
    "pct", "create", "591", "local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst",
    "--unprivileged", "1", "--features", "nesting=1,keyctl=1", "--dev0", "/dev/net/tun",
    "--memory", "4096", "--cores", "2", "--rootfs", "local-lvm:32",
    "--net0", "name=eth0,bridge=vmbr0,ip=192.168.68.50/22,gw=192.168.68.1",
    "--nameserver", "1.1.1.1",
    "--onboot", "1", "--tags", "umiak", "--hostname", "umiak-cp",
]


@pytest.fixture
def runner(tmp_path):
    return CtFake(tmp_path / "host")


NEWEST = "debian-13-standard_13.6-1_amd64.tar.zst"


def test_create_emits_exact_pct_create_and_downloads_newest_available_template(runner):
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert runner.commands.index(["pveam", "update"]) < runner.commands.index(["pveam", "download", "local", NEWEST])
    assert CREATE in runner.commands
    assert ["pct", "start", "591"] in runner.commands
    assert runner.commands.index(["pveam", "download", "local", NEWEST]) < runner.commands.index(CREATE)


def test_create_uses_newest_local_debian_13_template_without_download(runner):
    runner.local_templates = ["debian-13-standard_13.2-1_amd64.tar.zst", "debian-13-standard_13.10-1_amd64.tar.zst",
                              "debian-12-standard_12.12-1_amd64.tar.zst"]
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert not any(a[:2] == ["pveam", "download"] for a in runner.commands)
    create = next(a for a in runner.commands if a[:2] == ["pct", "create"])
    assert create[3] == "local:vztmpl/debian-13-standard_13.10-1_amd64.tar.zst"


def test_newer_point_release_is_picked_up(runner):
    runner.available.append("debian-13-standard_13.7-2_amd64.tar.zst")
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert ["pveam", "download", "local", "debian-13-standard_13.7-2_amd64.tar.zst"] in runner.commands


def test_no_debian_13_template_is_an_error(runner):
    runner.available = ["debian-12-standard_12.12-1_amd64.tar.zst"]
    with pytest.raises(InstallerError, match="Debian 13"):
        ct.create(runner, SPEC, sleep=lambda _: None)
    assert not any(a[:2] == ["pct", "create"] for a in runner.commands)


def test_pveam_update_failure_still_uses_local_template(runner):
    runner.local_templates = [NEWEST]
    runner.fail_on = lambda argv: argv == ["pveam", "update"]
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert CREATE in runner.commands


def test_create_installs_docker_and_tailscale_from_signed_repos_without_pipe_to_shell(runner):
    ct.create(runner, SPEC, sleep=lambda _: None)
    inside = runner.ct_commands()
    joined = [" ".join(a) for a in inside]
    assert any("download.docker.com/linux/debian/gpg" in j for j in joined)
    assert any("pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg" in j for j in joined)
    install = next(a for a in inside if "docker-compose-plugin" in a)
    assert {"docker-ce", "containerd.io", "tailscale", "iptables"}.issubset(install)
    assert not any("| sh" in j or "|sh" in j or "| bash" in j for j in joined)
    sources = [i for a, i in zip(runner.commands, runner.inputs, strict=True) if a[:2] == ["pct", "exec"] and i]
    assert any("Signed-By: /etc/apt/keyrings/docker.asc" in i for i in sources)
    assert any("signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg" in i for i in sources)
    # Key fingerprints are verified before the repositories are trusted.
    gpg = [n for n, a in enumerate(inside) if a[:2] == ["gpg", "--show-keys"]]
    update = [n for n, a in enumerate(inside) if a[-2:] == ["apt-get", "update"]]
    assert len(gpg) == 2 and gpg[-1] < update[-1]


@pytest.mark.parametrize("listing", [
    "pub:-\nfpr:::::::::DEADBEEF:\n",
    # The expected key plus a second primary key in the same file.
    f"pub:-\nfpr:::::::::{ct.DOCKER_KEY_FPR}:\npub:-\nfpr:::::::::DEADBEEF:\n",
    f"sub:-\nfpr:::::::::{ct.DOCKER_KEY_FPR}:\n",
    "pub:-\n",
])
def test_create_rejects_wrong_repository_key(runner, listing):
    original = runner._in_ct

    def bad_key(argv, input):
        if argv[:2] == ["gpg", "--show-keys"]:
            return listing
        return original(argv, input)

    runner._in_ct = bad_key
    with pytest.raises(InstallerError, match="signing key"):
        ct.create(runner, SPEC, sleep=lambda _: None)


def test_refuses_existing_ct_id_not_tagged_umiak(runner):
    runner.objects["/cluster/resources"].append({"vmid": 591, "type": "lxc", "name": "other", "tags": "home"})
    with pytest.raises(InstallerError, match="591"):
        ct.create(runner, SPEC, sleep=lambda _: None)
    assert not any(a[0] == "pct" for a in runner.commands)


def test_refuses_existing_vm_with_ct_id(runner):
    runner.objects["/cluster/resources"].append({"vmid": 591, "type": "qemu", "name": "umiak-x", "tags": "umiak"})
    with pytest.raises(InstallerError):
        ct.create(runner, SPEC, sleep=lambda _: None)


def test_existing_umiak_ct_is_resumed_not_recreated(runner):
    runner.objects["/cluster/resources"].append({"vmid": 591, "type": "lxc", "name": "umiak-cp", "tags": "umiak"})
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert not any(a[:2] == ["pct", "create"] for a in runner.commands)
    assert ["pct", "start", "591"] in runner.commands


def test_refuses_address_already_in_use(runner):
    runner.ip_in_use = True
    with pytest.raises(InstallerError, match="in use"):
        ct.create(runner, SPEC, sleep=lambda _: None)
    assert not any(a[:2] == ["pct", "create"] for a in runner.commands)


def test_create_sets_explicit_nameserver_without_searchdomain(runner):
    spec = ct.CtSpec(id=591, ip="192.168.68.50", cidr=22, gw="192.168.68.1", storage="local-lvm", dns="1.1.1.1,9.9.9.9")
    ct.create(runner, spec, sleep=lambda _: None)
    create = next(a for a in runner.commands if a[:2] == ["pct", "create"])
    assert create[create.index("--nameserver") + 1] == "1.1.1.1 9.9.9.9"
    assert "--searchdomain" not in create


def test_arping_detects_device_that_ignores_icmp(runner):
    runner.ip_arp_only = True
    with pytest.raises(InstallerError, match="in use"):
        ct.create(runner, SPEC, sleep=lambda _: None)
    assert ["arping", "-D", "-c", "2", "-w", "3", "-I", "vmbr0", "192.168.68.50"] in runner.commands
    assert not any(a[:2] == ["pct", "create"] for a in runner.commands)


def test_free_address_passes_arping_and_ping(runner):
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert any(a[0] == "arping" for a in runner.commands) and any(a[0] == "ping" for a in runner.commands)


def test_arping_failure_other_than_reply_is_an_error(runner):
    original = runner.run

    def run(argv, input=None):
        if argv[0] == "arping":
            raise ct.CommandError(argv, 2, "", "interface down")
        return original(argv, input)

    runner.run = run
    with pytest.raises(InstallerError, match="arping"):
        ct.check_target(runner, SPEC)


def test_missing_arping_falls_back_to_ping(tmp_path):
    fake = CtFake(tmp_path / "h", arping=False)
    fake.ip_arp_only = True
    ct.check_target(fake, SPEC)  # the checklist is what asks to install arping
    assert not any(a[0] == "arping" for a in fake.commands)


def test_dns_wait_times_out_with_clear_error_and_progress(runner):
    runner.dns_broken = True
    sleeps, said = [], []
    with pytest.raises(InstallerError, match=r"resolv\.conf.*100\.100\.100\.100"):
        ct.create(runner, SPEC, sleep=sleeps.append, say=said.append)
    assert len(sleeps) == 60 and sum(sleeps) == 120
    assert said and "DNS" in said[0]
    assert not any("apt-get" in a for a in runner.ct_commands())


@pytest.mark.parametrize("change", [{"ip": "192.168.68.300"}, {"cidr": 33}, {"gw": "10.0.0.1"}, {"storage": "-x"},
                                    {"id": 50}, {"ip": "192.168.68.1"}, {"dns": "not-an-ip"}, {"dns": ""}])
def test_rejects_invalid_spec(runner, change):
    values = {"id": 591, "ip": "192.168.68.50", "cidr": 22, "gw": "192.168.68.1", "storage": "local-lvm"}
    values.update(change)
    with pytest.raises(InstallerError):
        ct.create(runner, ct.CtSpec(**values), sleep=lambda _: None)
