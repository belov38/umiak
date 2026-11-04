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
import ipaddress
import json
import sys
import time
import urllib.parse
from pathlib import Path

from . import checklist, ct, day2, prepare_host, release, stack, state, tailnet
from .pve import CommandError, InstallerError, Runner, lvmthin_storages

SECRETS_DIR = day2.SECRETS_DIR
GUEST_DNS = "1.1.1.1"
SANDBOX_RANGE = (500, 589)
PROTECTED_VMIDS = (590, 599, 9000, 9001)
DEFAULT_CT_ID = 590
DEFAULT_RAM_CAP = 8192


class UsageError(InstallerError):
    pass


def menu_options(current: state.InstallState | None) -> list[str]:
    if current is None:
        return ["Install"]
    if current.phase != "complete":
        return ["Resume install", "Uninstall"]
    return ["Update", "Sign in a new browser", "Reset owner access", "Uninstall"]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="umiak-installer",
        description="Install or manage Umiak on this Proxmox VE node. Rerun the same command for every later action.",
    )
    parser.add_argument("--non-interactive", action="store_true", help="never prompt; every missing answer is an error")
    parser.add_argument("--yes", action="store_true", help="apply listed host changes without asking")
    parser.add_argument("--storage", help="LVM-thin storage for sandboxes and the control-plane CT")
    parser.add_argument("--ct-id", type=int, help=f"control-plane CT ID (default {DEFAULT_CT_ID})")
    parser.add_argument("--ct-ip", help="static LAN IPv4 address of the control-plane CT")
    parser.add_argument("--gateway-cidr", help="LAN router and prefix, e.g. 192.168.1.1/24 (default: from vmbr0)")
    parser.add_argument("--vmid-range", help="sandbox VMIDs (default 500-589)")
    parser.add_argument("--template-range", help="template VMIDs (default 600-699)")
    parser.add_argument("--ram-cap-mb", type=int, help=f"sandbox RAM cap in MiB, 2048-8192 (default {DEFAULT_RAM_CAP})")
    parser.add_argument("--hostname", help="tailnet hostname of the control plane (default umiak)")
    parser.add_argument("--action", choices=sorted(ACTIONS), help="day-2 action without the menu (non-interactive)")
    parser.add_argument("--version", help="Update: release version (default: the latest release)")
    parser.add_argument("--remove-guests", action="store_true",
                        help="Uninstall: also destroy Umiak sandboxes and templates in pool umiak")
    parser.add_argument("--remove-pve-objects", action="store_true",
                        help="Uninstall: also remove Umiak Proxmox objects and the node-agent")
    return parser


ACTIONS = {"update": "Update", "signin": "Sign in a new browser", "reset-owner": "Reset owner access",
           "uninstall": "Uninstall"}


class Ui:
    def __init__(self, interactive: bool, yes: bool, input_fn, out):
        self.interactive = interactive
        self.yes = yes
        self.input = input_fn
        self.say = out

    def ask(self, prompt: str, default: str | None, flag: str) -> str:
        if not self.interactive:
            if default is None:
                raise UsageError(f"Missing {flag} (required with --non-interactive)")
            return default
        while True:
            suffix = f" [{default}]" if default is not None else ""
            value = self.input(f"{prompt}{suffix}: ").strip()
            if value or default is not None:
                return value or default

    def confirm(self, prompt: str) -> bool:
        if self.yes:
            return True
        if not self.interactive:
            raise UsageError("The listed host changes need confirmation: rerun with --yes")
        return self.input(f"{prompt} [y/N]: ").strip().lower() in ("y", "yes")

    def choose(self, options: list[str]) -> str:
        for number, option in enumerate(options, 1):
            self.say(f"  {number}) {option}")
        while True:
            value = self.input("Choose an action: ").strip()
            if value.isdigit() and 1 <= int(value) <= len(options):
                return options[int(value) - 1]

    def typed(self, prompt: str, word: str) -> bool:
        """A destructive confirmation: the exact word; --yes stands in only in non-interactive mode."""
        if not self.interactive:
            if self.yes:
                return True
            raise UsageError("This action needs confirmation: rerun with --yes")
        return self.input(f"{prompt}: ").strip() == word

    def ask_bool(self, prompt: str, flag_value: bool) -> bool:
        """An opt-in choice: the flag, otherwise a prompt (interactive); never implied by --yes."""
        if flag_value or not self.interactive:
            return flag_value
        return self.input(f"{prompt} [y/N]: ").strip().lower() in ("y", "yes")

    def wait_enter(self, prompt: str) -> None:
        self.input(prompt)


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


def _lan_defaults(runner: Runner) -> str | None:
    """Router and prefix of vmbr0, e.g. 192.168.68.1/22; None when undetectable."""
    try:
        addrs = json.loads(runner.run(["ip", "-j", "-4", "addr", "show", "dev", "vmbr0"]))
        routes = json.loads(runner.run(["ip", "-j", "route", "show", "default"]))
        prefix = addrs[0]["addr_info"][0]["prefixlen"]
        gateway = next(row["gateway"] for row in routes if row.get("dev") == "vmbr0" and row.get("gateway"))
        return f"{gateway}/{prefix}"
    except (CommandError, ValueError, KeyError, IndexError, StopIteration):
        return None


def gather(runner: Runner, args, ui: Ui, saved: dict | None = None) -> dict:
    """Answers from flags, otherwise prompts (interactive) with defaults. Validated before any change.

    `saved` (answers of an unfinished install) become the defaults, so Resume
    can correct an answer (flag or prompt) instead of failing the same way again.
    """
    saved = saved or {}

    def default(key, fallback):
        return str(saved[key]) if key in saved else fallback

    lvm = [row["storage"] for row in lvmthin_storages(runner, runner.hostname())]
    storage = args.storage or ui.ask("LVM-thin storage for sandboxes", default("storage", lvm[0] if lvm else None),
                                     "--storage")
    vmids = _range(args.vmid_range or ui.ask("Sandbox VMID range", "500-589", "--vmid-range"), "--vmid-range")
    if vmids != SANDBOX_RANGE:
        raise UsageError("This release supports only the sandbox VMID range 500-589")
    tpl_default = f"{saved['tpl_min']}-{saved['tpl_max']}" if "tpl_min" in saved else "600-699"
    templates = _range(args.template_range or ui.ask("Template VMID range", tpl_default, "--template-range"),
                       "--template-range")
    if templates[0] < 500 or (templates[0] <= vmids[1] and vmids[0] <= templates[1]):
        raise UsageError("Template VMIDs must start at 500 or above and not overlap the sandbox range")
    if any(templates[0] <= vmid <= templates[1] for vmid in PROTECTED_VMIDS):
        raise UsageError("Template VMID range contains a protected VMID (590, 599, 9000, 9001)")
    ram = args.ram_cap_mb or _int(ui.ask("Sandbox RAM cap (MiB)", default("ram_cap_mb", str(DEFAULT_RAM_CAP)), "--ram-cap-mb"),
                                    "--ram-cap-mb")
    if not 2048 <= ram <= 8192:
        raise UsageError("Sandbox RAM cap must be 2048-8192 MiB")
    ct_id = args.ct_id or _int(ui.ask("Control-plane CT ID", default("ct_id", str(DEFAULT_CT_ID)), "--ct-id"), "--ct-id")
    if any(low <= ct_id <= high for low, high in (vmids, templates)):
        raise UsageError("The CT ID must lie outside the sandbox and template ranges")
    lan_default = f"{saved['gw']}/{saved['cidr']}" if "gw" in saved else _lan_defaults(runner)
    lan = args.gateway_cidr or ui.ask("LAN router and prefix", lan_default, "--gateway-cidr")
    if not args.ct_ip and "ct_ip" not in saved:
        ui.say("The control plane needs a static LAN address outside your router's DHCP pool "
               "(reserve it on the router); guests reach the gateway there.")
    ct_ip = args.ct_ip or ui.ask("Control-plane static IPv4 address", default("ct_ip", None), "--ct-ip")
    hostname = args.hostname or ui.ask("Tailnet hostname", default("hostname", "umiak"), "--hostname")
    try:
        gw, prefix = lan.split("/")
        spec = ct.CtSpec(id=ct_id, ip=str(ipaddress.IPv4Address(ct_ip)), cidr=int(prefix),
                         gw=str(ipaddress.IPv4Address(gw)), storage=storage)
    except ValueError as error:
        raise UsageError(f"Invalid address: {error}") from error
    if not tailnet.HOSTNAME.fullmatch(hostname):
        raise UsageError("Invalid tailnet hostname: use lowercase letters, digits and hyphens")
    try:
        ct.validate(spec)
        # Read-only: CT ID ownership and a free address, before any host change.
        ct.check_target(runner, spec)
    except UsageError:
        raise
    except InstallerError as error:
        raise UsageError(str(error)) from error
    return {"storage": storage, "vmid_min": vmids[0], "vmid_max": vmids[1], "tpl_min": templates[0],
            "tpl_max": templates[1], "ram_cap_mb": ram, "ct_id": ct_id, "ct_ip": spec.ip, "gw": spec.gw,
            "cidr": spec.cidr, "hostname": hostname, "guest_dns": GUEST_DNS}


def run_checklist(runner: Runner, ui: Ui, storage: str | None) -> None:
    for _ in range(2):
        failing = [check for check in checklist.inspect(runner, storage=storage) if not check.ok]
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
        self.ui.say(step + "…")

    def reached(self, phase: str) -> bool:
        return self.current is not None and state.PHASES.index(self.current.phase) >= state.PHASES.index(phase)

    def save(self, phase: str, answers: dict, tailnet_host: str | None = None) -> None:
        if self.reached(phase):
            phase = self.current.phase
        self.current = state.InstallState(
            version=1, ct_id=answers["ct_id"], ct_ip=answers["ct_ip"], node=self.runner.hostname(),
            release=self.bundle.version, tailnet_host=tailnet_host or (self.current and self.current.tailnet_host),
            phase=phase, answers=answers,
        )
        state.save(self.current, self.state_path)

    def plan(self, a: dict) -> None:
        self.ui.say("The installer will:")
        for line in [
            f"create or verify Umiak-only PVE objects (user umiak@pve, token, roles, pool, SDN zone umiak, "
            f"IPSet umiak-gateway with {a['ct_ip']}, group umiak-egress); vmbr0 and other guests are not touched",
            f"create CT {a['ct_id']} umiak-cp ({a['ct_ip']}/{a['cidr']} via {a['gw']}, storage {a['storage']}) "
            "with Docker and Tailscale from their signed apt repositories",
            f"install /usr/local/bin/umiak-node and {prepare_host.NODE_CONFIG}, add one forced-command key line "
            f"to {prepare_host.AUTHORIZED_KEYS}",
            "start the Umiak stack in the CT and publish it on your tailnet with tailscale serve",
        ]:
            self.ui.say("  - " + line)
        if not self.ui.confirm("Proceed?"):
            raise InstallerError("Cancelled; nothing was changed by this step. Rerun with --yes to accept.")

    def run(self, args) -> str:
        saved = dict(self.current.answers) if self.current is not None else {}
        self.progress("Checking prerequisites")
        run_checklist(self.runner, self.ui, args.storage or saved.get("storage"))
        self.step = "Questions"
        if saved and self.reached("ct-created"):
            a = saved  # The CT exists with these answers; they are fixed from here on.
        else:
            a = gather(self.runner, args, self.ui, saved)
        self.plan(a)
        runner, ct_id = self.runner, a["ct_id"]
        node = runner.hostname()

        cfg = prepare_host.PrepareConfig(node=node, storage=a["storage"], gateway_ip=a["ct_ip"], guest_dns=a["guest_dns"],
                                         vmid_min=a["vmid_min"], vmid_max=a["vmid_max"], tpl_min=a["tpl_min"],
                                         tpl_max=a["tpl_max"])
        out_dir = runner.path(SECRETS_DIR)
        self.progress("Preparing Proxmox objects")
        result = prepare_host.prepare(runner, cfg, out_dir)
        self.save("prepared", a)

        self.progress(f"Creating control-plane container {ct_id}")
        ct.create(runner, ct.CtSpec(id=ct_id, ip=a["ct_ip"], cidr=a["cidr"], gw=a["gw"], storage=a["storage"]),
                  sleep=self.sleep)
        self.save("ct-created", a)

        self.progress("Connecting the control plane to your tailnet")
        tailnet.up(runner, ct_id, a["hostname"], out=self.ui.say, sleep=self.sleep)
        while True:
            info = tailnet.status(runner, ct_id)
            try:
                tailnet.require_https(info)
                break
            except tailnet.TailnetNotReady as error:
                if not self.ui.interactive:
                    raise
                self.ui.say(str(error))
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
        return tailnet.claim_link(identity.dns_name, code)

    def start_stack(self, a: dict, result, identity: tailnet.TailnetInfo, out_dir: Path) -> None:
        day2.apply_stack(self.runner, a["ct_id"], self.bundle, a, result.node_ip, result.public_key, identity, out_dir,
                         self.sleep, agent_only_if_changed=False)

    def day2(self, action: str, args, download, latest) -> int:
        current, ui = self.current, self.ui
        common = {"ui": ui, "progress": self.progress}
        if action == "Update":
            self.step = "Choosing the release"
            version = args.version
            if not version:
                try:
                    version = latest()
                except (InstallerError, OSError) as error:
                    if not ui.interactive:
                        raise InstallerError(f"Cannot determine the latest release ({error}); pass --version") from error
                if ui.interactive:
                    version = ui.ask("Release version", version, "--version")
            version = release.valid_version(version)
            if version == self.bundle.version:
                bundle = self.bundle
            else:
                self.progress(f"Downloading release {version}")
                bundle = download(version, self.runner.path(prepare_host.STATE_DIR) / "releases")
            day2.update(self.runner, current, bundle, sleep=self.sleep, state_path=self.state_path, **common)
            ui.say(f"Umiak is updated to {bundle.version}.")
        elif action == "Sign in a new browser":
            link = day2.signin(self.runner, current, **common)
            ui.say("The link below signs in one browser within 10 minutes; other sessions stay valid. Do not share it.")
            ui.say(f"Open {link}")
        elif action == "Reset owner access":
            link = day2.reset_owner(self.runner, current, **common)
            if link is None:
                return 1
            ui.say("Owner access was reset. The link below is a one-time owner claim; do not share it.")
            ui.say(f"Open {link}")
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


def main(argv=None, runner: Runner | None = None, bundle: release.Release | None = None, out=print, input_fn=input,
         sleep=time.sleep, state_path: Path | None = None, download=release.download,
         latest=release.latest_version) -> int:
    args = build_parser().parse_args(argv)
    runner = runner or Runner()
    ui = Ui(interactive=not args.non_interactive, yes=args.yes, input_fn=input_fn, out=out)
    flow = None

    def step() -> str:
        return flow.step if flow is not None else "Starting the installer"

    try:
        bundle = bundle or release.current()
        flow = Flow(runner, ui, bundle, state_path or runner.path(str(state.DEFAULT_PATH)), sleep)
        options = menu_options(flow.current)
        if args.action:
            action = ACTIONS[args.action]
            if action not in options:
                raise UsageError(f"{action} is not available now; available: {', '.join(options)}")
        elif ui.interactive:
            out(f"Umiak installer {bundle.version}")
            action = ui.choose(options)
        elif options[0] in ("Install", "Resume install"):
            action = options[0]
        else:
            raise UsageError("Umiak is already installed; pass --action (" + ", ".join(sorted(ACTIONS)) + ")")
        if action not in ("Install", "Resume install"):
            return flow.day2(action, args, download, latest)
        link = flow.run(args)
        out(tailnet.key_expiry_hint(urllib.parse.urlsplit(link).hostname))
        out("Umiak is ready. The link below is a one-time owner claim; do not share it.")
        out(f"Open {link}")
        return 0
    except UsageError as error:
        out(f"Error: {error}")
        return 2
    except tailnet.TailnetNotReady as error:
        out(f"{error}\nThen rerun the installer to resume.")
        return 3
    except InstallerError as error:
        out(f"Error during '{step()}': {error}")
        return 1
    except CommandError as error:
        out(describe_failure(step(), error))
        return 1
    except KeyboardInterrupt:
        out("Interrupted. Rerun the installer to resume.")
        return 130


def run() -> int:
    return main(sys.argv[1:])
