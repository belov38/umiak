import json

import pytest

from fake_ct import CtFake
from test_menu import FLAGS
from umiak_installer import allocation, main, nodes


def answers(runner, *flags, saved=None):
    return main.gather(runner, main.build_parser().parse_args([*FLAGS, *flags]),
                       main.Ui(False, True, input, lambda _: None), saved)


def test_first_free_blocks_and_foreign_cluster_guests(tmp_path):
    runner = CtFake(tmp_path)
    runner.objects["/cluster/resources"].extend([
        {"vmid": 505, "node": "pve2", "name": "foreign"},
        {"vmid": 650, "node": "pve2", "name": "foreign"},
    ])
    with pytest.raises(main.UsageError, match="existing non-Umiak"):
        answers(runner)
    flags = main.build_parser().parse_args(["--non-interactive", "--ct-ip", "192.168.68.50"])
    a = main.gather(runner, flags, main.Ui(False, True, input, lambda _: None))
    assert (a["vmid_min"], a["vmid_max"]) == (10000, 19999)
    assert (a["tpl_min"], a["tpl_max"]) == (20000, 20099)
    assert a["ct_id"] == 590
    with pytest.raises(main.UsageError, match="existing non-Umiak"):
        answers(runner, "--vmid-range", "800-889", "--template-range", "640-739")
    with pytest.raises(main.UsageError, match="outside"):
        answers(runner, "--vmid-range", "800-889", "--template-range", "900-999", "--ct-id", "850")


def test_cluster_network_overlap_and_override(tmp_path, monkeypatch):
    runner = CtFake(tmp_path)
    original = nodes.HostConsole.call

    def remote(self, node, op, **data):
        if op == "networks":
            return {"addresses": [], "routes": [{"dst": "10.88.0.0/16"}]}
        return original(self, node, op, **data)

    monkeypatch.setattr(nodes.HostConsole, "call", remote)
    assert answers(runner)["guest_subnet"] == "10.89.0.0/18"
    with pytest.raises(main.UsageError, match="overlaps"):
        answers(runner, "--guest-subnet", "10.88.0.0/24")
    assert answers(runner, "--guest-subnet", "172.20.8.0/24")["guest_subnet"] == "172.20.8.0/24"
    assert runner.mutations() == []


def test_local_routes_and_sdn_inventory(tmp_path):
    runner = CtFake(tmp_path)
    runner.objects["/cluster/sdn/vnets"] = [{"vnet": "other"}]
    runner.objects["/cluster/sdn/vnets/other/subnets"] = [{"subnet": "other-10.89.0.0-24", "cidr": "10.89.0.0/24"}]
    original = runner.run

    def run(argv, input=None):
        if argv == ["ip", "-j", "-4", "route", "show", "table", "all"]:
            return json.dumps([{"dst": "default"}, {"dst": "10.88.0.0/24"}])
        return original(argv, input)

    runner.run = run
    assert answers(runner)["guest_subnet"] == "10.88.64.0/18"


def test_private_pool_fallback():
    import ipaddress
    assert allocation.choose_subnet([ipaddress.IPv4Network("10.0.0.0/8")]) == "172.16.0.0/18"


def test_legacy_saved_missing_allocation_keys(tmp_path):
    runner = CtFake(tmp_path)
    flags = main.build_parser().parse_args(["--non-interactive", "--ct-ip", "192.168.68.50"])
    a = main.gather(runner, flags, main.Ui(False, True, input, lambda _: None), {"storage": "local-lvm"})
    assert (a["vmid_min"], a["vmid_max"], a["tpl_min"], a["tpl_max"]) == (500, 589, 600, 699)
    assert a["guest_subnet"] == "10.88.0.0/24"


def test_next_free_large_subnet():
    import ipaddress
    assert allocation.choose_subnet([ipaddress.IPv4Network("10.88.0.0/24")]) == "10.88.64.0/18"


def test_new_large_subnet_dhcp_range(tmp_path):
    from dataclasses import replace

    from test_prepare_host import config
    from umiak_installer.prepare_host import prepare
    runner = CtFake(tmp_path)
    prepare(runner, replace(config(), guest_subnet="10.88.0.0/18",
                           vmid_min=10000, vmid_max=19999, tpl_min=20000, tpl_max=20099), tmp_path / "secrets")
    subnet = runner.objects[allocation.subnet_path()]
    assert subnet["gateway"] == "10.88.0.1"
    assert subnet["dhcp-range"] == "start-address=10.88.0.100,end-address=10.88.63.250"
