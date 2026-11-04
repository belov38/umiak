"""Tailscale inside the control-plane CT: login, HTTPS check, Serve, claim link.

The CT joins the owner's tailnet as `<hostname>`; the single public origin is
`https://<hostname>.<tailnet>.ts.net`, served by `tailscale serve` from the
trusted loopback listener 4181. DNS inside the CT is left alone
(`--accept-dns=false`) so Docker's resolver configuration stays stable.
"""

import ipaddress
import json
import re
import time
import urllib.parse
from dataclasses import dataclass

from . import style
from .ct import run_in
from .pve import CommandError, InstallerError, Runner

ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns"
MACHINES_URL = "https://login.tailscale.com/admin/machines"
HOSTNAME = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


class TailnetNotReady(InstallerError):
    MESSAGE = f"Enable MagicDNS and HTTPS certificates: {ADMIN_DNS_URL}"

    def __init__(self, message: str = MESSAGE):
        super().__init__(message)


@dataclass(frozen=True)
class TailnetInfo:
    dns_name: str
    ipv4: str


def status(runner: Runner, ct_id: int) -> dict:
    return json.loads(run_in(runner, ct_id, "tailscale", "status", "--json") or "{}")


def require_https(info: dict) -> None:
    """HTTPS certificates (and with them MagicDNS) must be on for the tailnet origin."""
    if not info.get("CertDomains"):
        raise TailnetNotReady()


def parse(info: dict) -> TailnetInfo:
    ipv4 = next((ip for ip in info.get("TailscaleIPs") or [] if ipaddress.ip_address(ip).version == 4), None)
    domains = info.get("CertDomains") or []
    dns_name = domains[0] if domains else str((info.get("Self") or {}).get("DNSName", "")).rstrip(".")
    if not ipv4 or not dns_name:
        raise InstallerError("Tailscale is up but reports no IPv4 address or DNS name")
    return TailnetInfo(dns_name, ipv4)


def up(runner: Runner, ct_id: int, hostname: str, out=print, sleep=time.sleep, timeout: float = 1800,
       clock=time.monotonic) -> TailnetInfo:
    """Join the tailnet: start login, print the login link once, wait until the backend runs."""
    if not HOSTNAME.fullmatch(hostname):
        raise InstallerError("Invalid tailnet hostname: use lowercase letters, digits and hyphens")
    try:
        # Returns after the timeout while login is pending; the backend keeps the auth URL.
        run_in(runner, ct_id, "tailscale", "up", f"--hostname={hostname}", "--accept-dns=false", "--timeout=15s")
    except CommandError:
        pass
    shown = None
    deadline = clock() + timeout
    while True:
        info = status(runner, ct_id)
        if info.get("BackendState") == "Running":
            return parse(info)
        url = info.get("AuthURL")
        if url and url != shown:
            style.action(out, "Open this link to connect Umiak to your tailnet:", url)
            shown = url
        if info.get("BackendState") == "NeedsMachineAuth" and shown != MACHINES_URL:
            style.action(out, "Approve this device in the Tailscale admin console:", MACHINES_URL)
            shown = MACHINES_URL
        if clock() >= deadline:
            raise InstallerError("Tailscale login did not complete in time; rerun the installer to resume")
        sleep(2)


def serve(runner: Runner, ct_id: int) -> None:
    run_in(runner, ct_id, "tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:4181")


def key_expiry_hint(dns_name: str) -> str:
    """Tailscale node keys expire (~180 days by default); the control plane must not drop off."""
    machine = dns_name.split(".", 1)[0]
    return f"Tip: disable key expiry for '{machine}' in Tailscale, or it drops off in ~180 days:"


def claim_link(dns_name: str, code: str) -> str:
    """Same shape as claimLink in deploy/compose/quickstart/owner.mjs (encodeURIComponent)."""
    return f"https://{dns_name}/claim#" + urllib.parse.quote(code, safe="-_.!~*'()")
