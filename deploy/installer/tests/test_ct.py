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
    "--onboot", "1", "--tags", "umiak", "--hostname", "umiak-cp",
]


@pytest.fixture
def runner(tmp_path):
    return CtFake(tmp_path / "host")


def test_create_emits_exact_pct_create_and_downloads_missing_template(runner):
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert ["pveam", "download", "local", ct.TEMPLATE] in runner.commands
    assert CREATE in runner.commands
    assert ["pct", "start", "591"] in runner.commands
    assert runner.commands.index(["pveam", "download", "local", ct.TEMPLATE]) < runner.commands.index(CREATE)


def test_create_skips_download_when_template_present(runner):
    runner.template_present = True
    ct.create(runner, SPEC, sleep=lambda _: None)
    assert not any(a[:2] == ["pveam", "download"] for a in runner.commands)


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


def test_create_rejects_wrong_repository_key(runner):
    original = runner._in_ct

    def bad_key(argv, input):
        if argv[:2] == ["gpg", "--show-keys"]:
            return "pub:-\nfpr:::::::::DEADBEEF:\n"
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


@pytest.mark.parametrize("change", [{"ip": "192.168.68.300"}, {"cidr": 33}, {"gw": "10.0.0.1"}, {"storage": "-x"},
                                    {"id": 50}, {"ip": "192.168.68.1"}])
def test_rejects_invalid_spec(runner, change):
    values = {"id": 591, "ip": "192.168.68.50", "cidr": 22, "gw": "192.168.68.1", "storage": "local-lvm"}
    values.update(change)
    with pytest.raises(InstallerError):
        ct.create(runner, ct.CtSpec(**values), sleep=lambda _: None)
