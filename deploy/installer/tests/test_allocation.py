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
    assert (a["vmid_min"], a["vmid_max"]) == (506, 595)
    assert (a["tpl_min"], a["tpl_max"]) == (651, 750)
    assert a["ct_id"] == 596
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
    assert answers(runner)["guest_subnet"] == "10.89.0.0/24"
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
    assert answers(runner)["guest_subnet"] == "10.90.0.0/24"


def test_private_pool_fallback():
    import ipaddress
    assert allocation.choose_subnet([ipaddress.IPv4Network("10.0.0.0/8")]) == "172.16.0.0/24"
