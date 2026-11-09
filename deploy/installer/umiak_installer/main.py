"""Installer entry: a menu driven by the detected install state, and the install flow.

Install order (each milestone persists `phase`, so a rerun offers Resume and
continues idempotently from saved answers):

  checklist (confirm fixes) -> questions -> PVE objects (prepare)    [prepared]
  -> control-plane CT with Docker and Tailscale                       [ct-created]
  -> tailnet login and HTTPS check                                    [tailnet-up]
  -> stack files, port filter, pull, node-agent from the image,
     host report, install.json, network config, secrets, up           [stack-up]
  -> tailscale serve, claim link                                      [complete]

The node-agent is installed before the first `up` so the quickstart bootstrap
import (which probes it) succeeds on the very first start.

A finished install offers the day-2 actions in day2.py (Update, Sign in a new
browser, Reset owner access, Uninstall); `--action` runs one without the menu.

Exit codes: 0 ok, 1 failure, 2 usage (missing or invalid answers, --yes needed), 3 tailnet not
ready in --non-interactive mode, 130 interrupted.
"""

import argparse
import dataclasses
import ipaddress
import json
import sys
import time
import urllib.parse
from pathlib import Path

from . import allocation, checklist, ct, day2, prepare_host, release, stack, state, style, tailnet, update_timer, updater
from .pve import CommandError, InstallerError, Runner, bridges, get, lan_bridge, lvmthin_storages
from .update_console import Console as UpdateConsole

SECRETS_DIR = day2.SECRETS_DIR
GUEST_DNS = "1.1.1.1"
DEFAULT_CT_ID = 590
DEFAULT_RAM_CAP = 8192


def _bad_channel():
    raise UsageError("Choose stable or edge")


class UsageError(InstallerError):
    pass


def menu_options(current: state.InstallState | None) -> list[str]:
    if current is None:
        return ["Install"]
    if current.phase != "complete":
        return ["Resume install", "Uninstall"]
    return ["Update", "Sign in a new browser", "Reset owner access", "Add or remove sandbox nodes", "Uninstall"]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="umiak-installer",
        description="Install or manage Umiak on this Proxmox VE node. Rerun the same command for every later action.",
    )
    parser.add_argument("--non-interactive", action="store_true", help="never prompt; every missing answer is an error")
    parser.add_argument("--scheduled", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--yes", action="store_true", help="apply listed host changes without asking")
    parser.add_argument("--storage", help="LVM-thin storage for sandboxes and the control-plane CT")
    parser.add_argument("--ct-id", type=int, help=f"control-plane CT ID (default {DEFAULT_CT_ID})")
    parser.add_argument("--ct-ip", help="static LAN IPv4 address of the control-plane CT")
    parser.add_argument("--bridge", help="LAN bridge for the control-plane CT (default: the bridge of the default route)")
    parser.add_argument("--gateway-cidr", help="LAN router and prefix, e.g. 192.168.1.1/24 (default: from the LAN bridge)")
    parser.add_argument("--guest-dns", help=f"DNS server(s) for sandboxes and the control-plane CT (default {GUEST_DNS})")
    parser.add_argument("--vmid-range", help="sandbox VMIDs (default 10000-19999)")
    parser.add_argument("--guest-subnet", help="isolated private guest IPv4 subnet (default /18) (auto-selected if omitted)")
    parser.add_argument("--template-range", help="template VMIDs (default 20000-20099)")
    parser.add_argument("--ram-cap-mb", type=int, help=f"sandbox RAM cap in MiB, 2048-8192 (default {DEFAULT_RAM_CAP})")
    parser.add_argument("--hostname", help="tailnet hostname of the control plane (default umiak)")
    parser.add_argument("--action", choices=sorted(ACTIONS), help="day-2 action without the menu (non-interactive)")
    parser.add_argument("--node", help="Sandbox node name from this cluster")
    parser.add_argument("--node-action", choices=["add", "remove"], help="Action for --action nodes")
    parser.add_argument("--delete-sandboxes", action="store_true",
                        help="Node remove: also delete the node's sandboxes, machines and snapshots (non-interactive)")
    parser.add_argument("--channel", choices=["stable", "edge"], help="platform and recipe release channel")
    parser.add_argument("--auto-update", choices=["on", "off"], help="enable or disable automatic updates")
    parser.add_argument("--version", help="Update: release version (default: the latest release)")
    parser.add_argument("--remove-guests", action="store_true",
                        help="Uninstall: also destroy Umiak sandboxes and templates in pool umiak")
    parser.add_argument("--remove-pve-objects", action="store_true",
                        help="Uninstall: also remove Umiak Proxmox objects and the node-agent")
    return parser


ACTIONS = {"update": "Update", "signin": "Sign in a new browser", "reset-owner": "Reset owner access",
           "uninstall": "Uninstall", "nodes": "Add or remove sandbox nodes"}


class Ui:
    def __init__(self, interactive: bool, yes: bool, input_fn, out):
        self.interactive = interactive
        self.yes = yes
        self.input = input_fn
        self.say = out

    def read(self, prompt: str) -> str:
        """One line from the user; undecodable bytes (another keyboard layout, a half-erased
        multibyte character) are reported and asked again instead of crashing."""
        while True:
            try:
                return self.input(prompt).strip()
            except UnicodeDecodeError:
                self.say("  Could not read that input; type it again using Latin letters and digits.")

    def ask(self, prompt: str, default: str | None, flag: str, check=None):
        """A prompt with a default. `check` validates and normalizes the answer: it raises
        UsageError, which interactive mode prints before asking again."""
        if not self.interactive:
            if default is None:
                raise UsageError(f"Missing {flag} (required with --non-interactive)")
            return check(default) if check else default
        while True:
            suffix = f" [{default}]" if default is not None else ""
            value = self.read(f"{prompt}{suffix}: ") or default
            if value is None:
                continue
            if check is None:
                return value
            try:
                return check(value)
            except UsageError as error:
                self.say(f"  {error}")

    def confirm(self, prompt: str) -> bool:
        if self.yes:
            return True
        if not self.interactive:
            raise UsageError("The listed host changes need confirmation: rerun with --yes")
        return self.read(f"{prompt} [y/N]: ").lower() in ("y", "yes")

    def choose(self, options: list[str]) -> str:
        for number, option in enumerate(options, 1):
            self.say(f"  {number}) {option}")
        while True:
            value = self.read("Choose an action: ")
            if value.isdigit() and 1 <= int(value) <= len(options):
                return options[int(value) - 1]

    def typed(self, prompt: str, word: str) -> bool:
        """A destructive confirmation: the exact word; --yes stands in only in non-interactive mode."""
        if not self.interactive:
            if self.yes:
                return True
            raise UsageError("This action needs confirmation: rerun with --yes")
        return self.read(f"{prompt}: ") == word

    def ask_bool(self, prompt: str, flag_value: bool) -> bool:
        """An opt-in choice: the flag, otherwise a prompt (interactive); never implied by --yes."""
        if flag_value or not self.interactive:
            return flag_value
        return self.read(f"{prompt} [y/N]: ").lower() in ("y", "yes")

    def ask_yes(self, prompt: str) -> bool:
        """A yes/no question that defaults to yes (interactive only)."""
        return self.read(f"{prompt} [Y/n]: ").lower() in ("", "y", "yes")

    def wait_enter(self, prompt: str) -> None:
        self.read(prompt)


def _range(text: str, flag: str) -> tuple[int, int]:
    try:
        low, high = (int(part) for part in text.split("-"))
    except ValueError as error:
        raise UsageError(f"{flag} must look like 500-589") from error
    if not 100 <= low <= high <= 999_999_999:
        raise UsageError(f"Invalid {flag}")
    return low, high


def _int(text: str, flag: str) -> int:
    try:
        return int(text)
    except ValueError as error:
        raise UsageError(f"{flag} must be a number") from error


def _lan_defaults(runner: Runner, bridge: str) -> str | None:
    """Router and prefix of the LAN bridge, e.g. 192.168.68.1/22; None when undetectable."""
    try:
        addrs = json.loads(runner.run(["ip", "-j", "-4", "addr", "show", "dev", bridge]))
        routes = json.loads(runner.run(["ip", "-j", "route", "show", "default"]))
        prefix = addrs[0]["addr_info"][0]["prefixlen"]
        gateway = next(row["gateway"] for row in routes if row.get("dev") == bridge and row.get("gateway"))
        return f"{gateway}/{prefix}"
    except (CommandError, ValueError, KeyError, IndexError, StopIteration):
        return None


def gather(runner: Runner, args, ui: Ui, saved: dict | None = None) -> dict:
    """Answers from flags, otherwise prompts (interactive) with defaults. Validated before any change.

    Each answer is checked as it is given: an invalid flag is a usage error, an invalid
    interactive answer is explained and asked again. `saved` (answers of an unfinished
    install) become the defaults, so Resume can correct an answer instead of failing again.
    """
    saved = saved or {}

    def default(key, fallback):
        return str(saved[key]) if key in saved else fallback

    def field(flag_value, prompt, fallback, flag, check):
        if flag_value is not None and flag_value != "":
            return check(str(flag_value))
        return ui.ask(prompt, fallback, flag, check)

    lvm = [row["storage"] for row in lvmthin_storages(runner, runner.hostname())]

    def check_storage(value):
        if lvm and value not in lvm:
            raise UsageError(f"No LVM-thin storage named {value} on this node; available: {', '.join(lvm)}")
        return value

    storage_prompt = "LVM-thin storage for sandboxes" + (f" ({', '.join(lvm)})" if len(lvm) > 1 else "")
    storage = field(args.storage or (lvm[0] if len(lvm) == 1 else None), storage_prompt,
                    default("storage", lvm[0] if lvm else None), "--storage",
                    check_storage)

    ct.template_storage(runner)  # Fail before host changes if no CT template storage exists.
    guests = get(runner, "/cluster/resources", "--type", "vm")
    occupied = {int(g["vmid"]) for g in guests if not checklist._is_umiak(g)}

    def check_range(value, flag):
        span = _range(value, flag)
        taken = sorted(v for v in occupied if span[0] <= v <= span[1])
        if taken:
            raise UsageError(f"{flag} contains existing non-Umiak guests: {taken}")
        return span

    def automatic(flag, low_key, high_key, start, size, excluded=()):
        if flag:
            return flag
        if saved:
            legacy = {"vmid_min": 500, "vmid_max": 589, "tpl_min": 600, "tpl_max": 699}
            return f"{saved.get(low_key, legacy[low_key])}-{saved.get(high_key, legacy[high_key])}"
        low, high = allocation.free_block(start, size, occupied, excluded)
        return f"{low}-{high}"

    reserved_ct = ((args.ct_id, args.ct_id),) if args.ct_id is not None else ()
    reserved_templates = (_range(args.template_range, "--template-range"),) if args.template_range else ()
    vmids = check_range(automatic(args.vmid_range, "vmid_min", "vmid_max", 10000, 10000,
                                  reserved_ct + reserved_templates), "--vmid-range")
    templates = check_range(automatic(args.template_range, "tpl_min", "tpl_max", 20000, 100, (vmids,) + reserved_ct),
                            "--template-range")
    if templates[0] <= vmids[1] and vmids[0] <= templates[1]:
        raise UsageError("Template VMIDs must not overlap the sandbox range")

    try:
        networks = allocation.occupied_networks(runner, resume=bool(saved))
    except (ValueError, KeyError, TypeError) as error:
        raise InstallerError(f"Cannot inspect cluster networks: {error}") from error
    subnet = args.guest_subnet or saved.get("guest_subnet") or (
        "10.88.0.0/24" if saved else allocation.choose_subnet(networks))
    try:
        net = ipaddress.IPv4Network(subnet)
        if not 18 <= net.prefixlen <= 24 or not any(net.subnet_of(ipaddress.IPv4Network(private))
                                        for private in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
            raise ValueError("use a private IPv4 /18 to /24")
        if any(net.overlaps(other) for other in networks):
            raise ValueError("overlaps cluster addresses, routes or SDN subnets")
    except (ValueError, TypeError) as error:
        raise UsageError(f"Invalid --guest-subnet: {error}") from error

    def check_ram(value):
        ram = _int(value, "--ram-cap-mb")
        if not 2048 <= ram <= 8192:
            raise UsageError("Sandbox RAM cap must be 2048-8192 MiB")
        return ram

    ram = check_ram(str(args.ram_cap_mb if args.ram_cap_mb is not None
                        else saved.get("ram_cap_mb", DEFAULT_RAM_CAP)))

    def check_ct_id(value):
        ct_id = _int(value, "--ct-id")
        if not 100 <= ct_id <= 999_999_999:
            raise UsageError("Invalid CT ID")
        if any(low <= ct_id <= high for low, high in (vmids, templates)):
            raise UsageError("The CT ID must lie outside the sandbox and template ranges")
        row = ct.existing(runner, ct_id)
        if row is not None and not ct.is_umiak_ct(row):
            raise UsageError(f"Guest {ct_id} exists and is not an Umiak container; choose another CT ID")
        return ct_id

    ct_default = saved.get("ct_id")
    if ct_default is None:
        ct_default = allocation.free_block(DEFAULT_CT_ID, 1, {int(g["vmid"]) for g in guests}, (vmids, templates))[0]
    ct_id = check_ct_id(str(args.ct_id if args.ct_id is not None else ct_default))

    def check_lan(value):
        try:
            gw, prefix = value.split("/")
            gw = str(ipaddress.IPv4Address(gw))
            cidr = int(prefix)
        except ValueError as error:
            raise UsageError(f"LAN router and prefix must look like 192.168.1.1/24 ({error})") from error
        if not 8 <= cidr <= 30:
            raise UsageError("The LAN prefix length must be 8-30")
        return gw, cidr

    known = bridges(runner)

    def check_bridge(value):
        if value not in known:
            raise UsageError(f"No Linux bridge named {value} on this node; bridges: {', '.join(known) or 'none'}")
        return value

    detected = saved.get("bridge") or lan_bridge(runner)
    if args.bridge:
        bridge = check_bridge(args.bridge)
    elif detected:
        bridge = detected  # The bridge of the default route: no question needed.
    else:
        ui.say("Could not tell which bridge is your LAN (no default route on a bridge).")
        bridge = ui.ask("LAN bridge for the control plane" + (f" ({', '.join(known)})" if known else ""),
                        known[0] if len(known) == 1 else None, "--bridge", check_bridge)
    lan_default = f"{saved['gw']}/{saved['cidr']}" if "gw" in saved else _lan_defaults(runner, bridge)
    gw, cidr = field(args.gateway_cidr or lan_default, "LAN router and prefix", lan_default, "--gateway-cidr", check_lan)
    network = ipaddress.IPv4Network(f"{gw}/{cidr}", strict=False)
    ct_exists = ct.existing(runner, ct_id) is not None

    def check_ip(value):
        try:
            ip = ipaddress.IPv4Address(value)
        except ValueError as error:
            raise UsageError(f"Invalid address: {error}") from error
        if ip not in network or str(ip) == gw or ip in (network.network_address, network.broadcast_address):
            raise UsageError(f"The address must be a host address in {network} other than the router")
        if not ct_exists and ct.address_in_use(runner, str(ip), bridge):
            raise UsageError(f"Address {ip} is already in use on the LAN; choose a free static address")
        return str(ip)

    ip_default = default("ct_ip", None)
    if not args.ct_ip and "ct_ip" not in saved:
        ui.say("The control plane needs a fixed LAN address outside your router's DHCP range.")
        if ui.interactive:
            ui.say("Looking for a free address…")
            ip_default = ct.suggest_ip(runner, gw, cidr, bridge)
            if ip_default:
                ui.say(f"Suggested: {style.bold(ip_default)} (free on the LAN)")
    ct_ip = field(args.ct_ip, "Control-plane static IPv4 address", ip_default, "--ct-ip", check_ip)

    def check_hostname(value):
        if not tailnet.HOSTNAME.fullmatch(value):
            raise UsageError("Invalid tailnet hostname: use lowercase letters, digits and hyphens")
        return value

    hostname = check_hostname(args.hostname or saved.get("hostname", "umiak"))
    dns = args.guest_dns or saved.get("guest_dns") or GUEST_DNS
    spec = ct.CtSpec(id=ct_id, ip=ct_ip, cidr=cidr, gw=gw, storage=storage, dns=dns, bridge=bridge)
    try:
        ct.validate(spec)
    except InstallerError as error:
        raise UsageError(str(error)) from error
    return {"guest_subnet": str(net), "storage": storage, "vmid_min": vmids[0], "vmid_max": vmids[1], "tpl_min": templates[0],
            "tpl_max": templates[1], "ram_cap_mb": ram, "ct_id": ct_id, "ct_ip": spec.ip, "gw": spec.gw,
            "cidr": spec.cidr, "hostname": hostname, "guest_dns": dns, "bridge": bridge}


def run_checklist(runner: Runner, ui: Ui, storage: str | None) -> None:
    for _ in range(2):
        failing = [check for check in checklist.inspect(runner, storage=storage, ranges=()) if not check.ok]
        if not failing:
            return
        for check in failing:
            ui.say(f"Prerequisite {check.name}: {check.detail}")
            if check.fix is None:
                raise InstallerError(f"Prerequisite not met: {check.name} ({check.detail})")
            ui.say("  Change: " + check.fix.description)
            for path, content in check.fix.files.items():
                ui.say(f"    write {path}: {content.strip()}")
            for argv in check.fix.commands:
                ui.say("    run: " + " ".join(argv))
            if not ui.confirm("Apply this change?"):
                raise InstallerError(f"Prerequisite not met: {check.name}. Apply the change above or rerun with --yes.")
            checklist.apply_fix(runner, check.fix)
    raise InstallerError("Prerequisites still not met after the fixes; see the messages above")


class Flow:
    def __init__(self, runner: Runner, ui: Ui, bundle: release.Release, state_path: Path, sleep):
        self.runner = runner
        self.ui = ui
        self.bundle = bundle
        self.state_path = state_path
        self.sleep = sleep
        self.current: state.InstallState | None = state.load(state_path)
        self.step = "Starting the installer"

    def progress(self, step: str) -> None:
        self.step = step
        self.ui.say("")
        self.ui.say(style.step(step + "…"))

    def reached(self, phase: str) -> bool:
        return self.current is not None and state.PHASES.index(self.current.phase) >= state.PHASES.index(phase)

    def save(self, phase: str, answers: dict, tailnet_host: str | None = None) -> None:
        if self.reached(phase):
            phase = self.current.phase
        self.current = state.InstallState(
            version=1, ct_id=answers["ct_id"], ct_ip=answers["ct_ip"], node=self.runner.hostname(),
            release=self.bundle.version, tailnet_host=tailnet_host or (self.current and self.current.tailnet_host),
            phase=phase, answers=answers,
            channel=answers.get("channel", "stable"), auto_update=answers.get("auto_update", True),
        )
        state.save(self.current, self.state_path)

    def offer_nodes(self) -> None:
        """After a fresh install: offer the other online cluster nodes as sandbox nodes."""
        from . import nodes
        try:
            others = nodes.candidates(self.runner, self.current)
        except (InstallerError, CommandError, ValueError, KeyError):
            return  # The node offer is optional; the menu action stays available.
        if not others:
            return
        ui = self.ui
        self.progress("Other cluster nodes")
        ui.say(f"This cluster has {len(others)} more online node(s): {', '.join(others)}. Sandboxes can run there "
               "too; the installer adds a restricted node-agent to each node you choose.")
        later = "You can add it later: rerun the installer and choose 'Add or remove sandbox nodes'."
        for node in others:
            if not ui.ask_yes(f"Add {node} as a sandbox node?"):
                continue
            self.step = f"Adding sandbox node {node}"
            try:
                nodes.add_node(self.runner, self.current, self.bundle, node, ui=ui, confirmed=True)
                ui.say(style.ok(f"Sandbox node {node} added."))
            except CommandError as error:
                ui.say(style.error(describe_failure(self.step, error)))
                ui.say(later)
            except InstallerError as error:
                ui.say(style.error(f"Could not add {node}: {error}"))
                ui.say(later)
        try:
            self.current = nodes.remember(self.runner, self.current, self.state_path)
        except (InstallerError, CommandError):
            pass

    def plan(self, a: dict) -> None:
        self.ui.say("")
        self.ui.say(style.step("The installer will:"))
        for line in [
            "add the Umiak user, pool, network and firewall rules to Proxmox",
            f"create container {a['ct_id']} (umiak-cp): {a['ct_ip']} on {a.get('bridge', 'vmbr0')}, "
            f"disk on {a['storage']}",
            "install the Umiak node agent on this node",
            "start Umiak and publish it on your tailnet",
        ]:
            self.ui.say("  • " + line)
        subnet = a.get('guest_subnet', allocation.DEFAULT_SUBNET)
        if (a['vmid_min'], a['vmid_max'], a['tpl_min'], a['tpl_max'], subnet) != (500, 589, 600, 699, allocation.DEFAULT_SUBNET):
            self.ui.say(f"  VMIDs: sandboxes {a['vmid_min']}-{a['vmid_max']}, "
                        f"templates {a['tpl_min']}-{a['tpl_max']}; guests {subnet}")
        self.ui.say(style.dim("  Other guests and host network settings stay unchanged."))
        if not self.ui.confirm("Proceed?"):
            raise InstallerError("Cancelled; nothing was changed by this step. Rerun with --yes to accept.")

    def run(self, args) -> str:
        saved = dict(self.current.answers) if self.current is not None else {}
        self.progress("Checking prerequisites")
        self.step = "Questions"
        if saved and self.reached("ct-created"):
            a = saved  # The CT exists with these answers; they are fixed from here on.
        else:
            if self.ui.interactive:
                self.ui.say("")
                self.ui.say(style.step("Questions"))
            a = gather(self.runner, args, self.ui, saved)
        a["channel"] = args.channel or a.get("channel", "stable")
        a["auto_update"] = args.auto_update == "on" if args.auto_update else a.get("auto_update", True)
        # Validate allocations before even prerequisite repairs change this host.
        if saved and self.reached("ct-created"):
            gather_args = argparse.Namespace(**vars(args))
            for key in ("storage", "ct_ip", "gateway_cidr", "hostname"):
                setattr(gather_args, key, getattr(args, key) or
                        (f"{a['gw']}/{a['cidr']}" if key == "gateway_cidr" else a.get(key)))
            gather(self.runner, gather_args, Ui(False, True, self.ui.input, self.ui.say), a)
        run_checklist(self.runner, self.ui, args.storage or a.get("storage"))
        self.plan(a)
        runner, ct_id = self.runner, a["ct_id"]
        node = runner.hostname()

        cfg = prepare_host.PrepareConfig(node=node, storage=a["storage"], gateway_ip=a["ct_ip"], guest_dns=a["guest_dns"],
                                         vmid_min=a["vmid_min"], vmid_max=a["vmid_max"], tpl_min=a["tpl_min"],
                                         tpl_max=a["tpl_max"], guest_subnet=a.get("guest_subnet", allocation.DEFAULT_SUBNET),
                                         bridge=a.get("bridge", "vmbr0"))
        out_dir = runner.path(SECRETS_DIR)
        self.progress("Preparing Proxmox objects")
        result = prepare_host.prepare(runner, cfg, out_dir)
        self.save("prepared", a)

        self.progress(f"Creating control-plane container {ct_id}")
        ct.create(runner, ct.CtSpec(id=ct_id, ip=a["ct_ip"], cidr=a["cidr"], gw=a["gw"], storage=a["storage"],
                                  dns=a["guest_dns"], bridge=a.get("bridge", "vmbr0")),
                  sleep=self.sleep, say=self.ui.say)
        self.save("ct-created", a)

        self.progress("Connecting the control plane to your tailnet")
        joined = tailnet.up(runner, ct_id, a["hostname"], out=self.ui.say, sleep=self.sleep)
        renamed = tailnet.rename_hint(a["hostname"], joined.dns_name)
        if renamed:
            self.ui.say(renamed)
        while True:
            info = tailnet.status(runner, ct_id)
            try:
                tailnet.require_https(info)
                break
            except tailnet.TailnetNotReady:
                if not self.ui.interactive:
                    raise
                style.action(self.ui.say, "Enable MagicDNS and HTTPS certificates in Tailscale:", tailnet.ADMIN_DNS_URL)
                self.ui.wait_enter("Press Enter after enabling them to check again… ")
        identity = tailnet.parse(info)
        self.save("tailnet-up", a, identity.dns_name)

        self.progress("Starting the Umiak stack")
        self.start_stack(a, result, identity, out_dir)
        self.save("stack-up", a)

        self.progress("Publishing the control plane on your tailnet")
        tailnet.serve(runner, ct_id)
        code = stack.wait_claim_code(runner, ct_id, sleep=self.sleep)
        self.save("complete", a)
        UpdateConsole(self.runner, self.current).call(
            settings={"channel": self.current.channel, "auto": self.current.auto_update,
                      "paused": False, "start": "03:00", "end": "04:00"},
            status={"version": self.current.release, "channel": self.current.channel, "updating": False},
        )
        update_timer.install(self.runner, self.bundle)
        return tailnet.claim_link(identity.dns_name, code)

    def start_stack(self, a: dict, result, identity: tailnet.TailnetInfo, out_dir: Path) -> None:
        day2.apply_stack(self.runner, a["ct_id"], self.bundle, a, result.node_ip, result.public_key, identity, out_dir,
                         self.sleep, agent_only_if_changed=False,
                         say=lambda line: self.ui.say(style.dim("  " + line)))

    def day2(self, action: str, args, download, latest) -> int:
        current, ui = self.current, self.ui
        common = {"ui": ui, "progress": self.progress}
        if action == "Update":
            self.step = "Choosing the release"
            console = UpdateConsole(self.runner, current)
            update_info = console.call()
            settings = updater.validate_settings(update_info["settings"])
            channel = args.channel or settings["channel"]
            if args.scheduled:
                if settings["paused"]:
                    ui.say("Updates paused; skipping.")
                    return 0
                if not updater.in_window(settings["start"], settings["end"]):
                    ui.say("Outside the host maintenance window; skipping.")
                    return 0
            if ui.interactive and not args.channel:
                channel = ui.ask("Release channel (stable/edge)", channel, "--channel",
                                 lambda value: value if value in ("stable", "edge") else _bad_channel())
            current = dataclasses.replace(current, channel=channel,
                                          auto_update=args.auto_update == "on" if args.auto_update else settings["auto"])
            settings.update(channel=channel, auto=current.auto_update)
            console.call(settings=settings)
            state.save(current, self.state_path)
            version = args.version
            if not version:
                try:
                    version = latest() if channel == "stable" else release.channel_version(channel)
                except (InstallerError, OSError) as error:
                    if not ui.interactive:
                        raise InstallerError(f"Cannot determine the latest release ({error}); pass --version") from error
                if ui.interactive:
                    version = ui.ask("Release version", version, "--version")
            version = release.valid_version(version)
            if args.scheduled:
                newer = current.release.startswith("dev-") or updater.release_newer(version, current.release)
                if not newer:
                    ui.say("Already running the newest release in this channel.")
                    return 0
                if updater.quarantined(current.release, version, update_info.get("history", [])):
                    ui.say("This release previously rolled back; waiting for a newer release or manual Update.")
                    return 0
                if not settings["auto"]:
                    console.call(record={"status": "available", "from": current.release, "to": version,
                                         "finishedAt": updater.timestamp()})
                    return 0
            if version == self.bundle.version:
                bundle = self.bundle
            else:
                self.progress(f"Downloading release {version}")
                bundle = download(version, self.runner.path(prepare_host.STATE_DIR) / "releases")
            try:
                self.current = updater.run_update(
                    self.runner, current, bundle, ui=ui, sleep=self.sleep, state_path=self.state_path,
                )
            except updater.UpdateSkipped as error:
                ui.say(str(error))
                return 0
            update_timer.install(self.runner, bundle)
            ui.say(f"Umiak is updated to {bundle.version}.")
        elif action == "Sign in a new browser":
            link = day2.signin(self.runner, current, **common)
            style.action(ui.say, "Open this link in the new browser:", link,
                         "It works once within 10 minutes; other sessions stay valid. Do not share it.")
        elif action == "Reset owner access":
            link = day2.reset_owner(self.runner, current, **common)
            if link is None:
                return 1
            ui.say(style.ok("Owner access was reset."))
            style.action(ui.say, "Open this link to claim owner access again:", link,
                         "It is a one-time owner claim; do not share it.")
        elif action == "Add or remove sandbox nodes":
            from . import nodes
            self.step = "Managing sandbox nodes"
            operation = args.node_action or ui.ask("Node action (add/remove)", None, "--node-action")
            if operation not in ("add", "remove"):
                raise UsageError("--node-action must be add or remove")
            node = args.node
            if not node:
                names = (nodes.candidates(self.runner, current) if operation == "add"
                         else [n for n in current.sandbox_nodes if n != current.node])
                if operation == "add" and not names:
                    raise InstallerError("Every online cluster node is already a sandbox node")
                hint = f" ({', '.join(names)})" if names else ""
                node = ui.ask(f"Sandbox node name{hint}", names[0] if len(names) == 1 else None, "--node")
            if operation == "add":
                nodes.add_node(self.runner, current, self.bundle, node, ui=ui, storage=args.storage,
                               ram_cap_mb=args.ram_cap_mb)
            else:
                nodes.remove_node(self.runner, current, node, ui=ui, delete_sandboxes=args.delete_sandboxes)
            self.current = nodes.remember(self.runner, current, self.state_path)
            ui.say(f"Sandbox node {node}: {operation} complete.")
        elif action == "Uninstall":
            self.step = "Uninstall questions"
            guests = ui.ask_bool("Also destroy the Umiak sandboxes and templates in pool umiak?", args.remove_guests)
            objects = ui.ask_bool("Also remove the Umiak Proxmox objects and the node-agent?", args.remove_pve_objects)
            day2.uninstall(self.runner, current, objects, guests, state_path=self.state_path, **common)
            ui.say("Umiak is uninstalled.")
        return 0


def describe_failure(step: str, error: CommandError, tail: int = 20) -> str:
    """Step, the command (inside the CT for `pct exec`) and the end of its stderr.

    Secrets never travel in argv (files and stdin only), so the command is safe to show.
    """
    argv = error.argv
    shown = argv[4:] if argv[:2] == ["pct", "exec"] and len(argv) > 4 else argv
    lines = [f"Error during '{step}': `{' '.join(shown)}` failed with exit code {error.returncode}."]
    output = (error.stderr or "").strip().splitlines()[-tail:]
    if output:
        lines.append(f"Last {len(output)} lines of its error output:")
        lines.extend(output)
    lines.append("Fix the cause and rerun the installer to resume.")
    return "\n".join(lines)


def _main(argv=None, runner: Runner | None = None, bundle: release.Release | None = None, out=print, input_fn=input,
         sleep=time.sleep, state_path: Path | None = None, download=release.download,
         latest=release.latest_version) -> int:
    args = build_parser().parse_args(argv)
    # Output is block-buffered when redirected to a file or pipe; long waits must stay visible.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(line_buffering=True)
    runner = runner or Runner()
    ui = Ui(interactive=not args.non_interactive, yes=args.yes, input_fn=input_fn, out=out)
    flow = None

    def step() -> str:
        return flow.step if flow is not None else "Starting the installer"

    try:
        bundle = bundle or release.current()
        resolved_state_path = state_path or runner.path(str(state.DEFAULT_PATH))
        updater.recover(runner, ui=ui, state_path=resolved_state_path, sleep=sleep)
        flow = Flow(runner, ui, bundle, resolved_state_path, sleep)
        options = menu_options(flow.current)
        if args.action:
            action = ACTIONS[args.action]
            if action not in options:
                raise UsageError(f"{action} is not available now; available: {', '.join(options)}")
        elif ui.interactive:
            running = flow.current.release if flow.current else bundle.version
            channel = flow.current.channel if flow.current else args.channel or "stable"
            out(style.bold(f"Umiak {running} · {channel} (installer {bundle.version})"))
            if running.startswith("dev-"):
                out("Dev build: Update replaces it with a published release.")
            if flow.current and not flow.current.auto_update:
                out("Automatic updates are available: enable in Settings or Update (--auto-update on).")
            action = ui.choose(options) if len(options) > 1 else options[0]
        elif options[0] in ("Install", "Resume install"):
            action = options[0]
        else:
            raise UsageError("Umiak is already installed; pass --action (" + ", ".join(sorted(ACTIONS)) + ")")
        if action not in ("Install", "Resume install"):
            return flow.day2(action, args, download, latest)
        link = flow.run(args)
        if ui.interactive:
            flow.offer_nodes()
        out("")
        out(style.ok("Installed. Continue setup in your browser."))
        out("")
        out(tailnet.key_expiry_hint(urllib.parse.urlsplit(link).hostname))
        out("  " + style.link(tailnet.MACHINES_URL))
        style.action(out, "On a device in your tailnet, open:", link, "One-time link, do not share it.")
        out("  Then build the Linux template (~10 min) and run the test.")
        return 0
    except UsageError as error:
        out(style.error(f"Error: {error}"))
        return 2
    except tailnet.TailnetNotReady as error:
        out(f"{error}\nThen rerun the installer to resume.")
        return 3
    except InstallerError as error:
        out(style.error(f"Error during '{step()}': {error}"))
        return 1
    except CommandError as error:
        out(style.error(describe_failure(step(), error)))
        return 1
    except KeyboardInterrupt:
        out("Interrupted. Rerun the installer to resume.")
        return 130


def main(argv=None, runner=None, **kwargs):
    runner = runner or Runner()
    try:
        with updater.action_lock(runner):
            return _main(argv, runner=runner, **kwargs)
    except InstallerError as error:
        kwargs.get("out", print)(str(error))
        return 1


def run() -> int:
    try:
        import readline  # noqa: F401  # line editing for input(): arrows, and backspace over multibyte characters
    except ImportError:
        pass
    return main(sys.argv[1:])
