"""Install/remove a host-only systemd polling timer and trusted Python runtime."""
import shutil
from pathlib import Path

from . import release
from .pve import private_dir, write_secret
from .updater import ROOT

SERVICE = """[Unit]
Description=Umiak host-owned platform updater
After=pve-cluster.service network-online.target
[Service]
Type=oneshot
WorkingDirectory={directory}
ExecStart=/usr/bin/python3 -m umiak_installer --action update --non-interactive --scheduled
UMask=0022
TimeoutStartSec=2h
"""
TIMER = """[Unit]
Description=Check Umiak update policy and maintenance window
[Timer]
OnCalendar=*:0/15
Persistent=true
RandomizedDelaySec=60
[Install]
WantedBy=timers.target
"""


def install(runner, bundle):
    version = release.valid_version(bundle.version)
    directory = ROOT + "/runtime/" + version
    root = runner.path(directory)
    private_dir(root.parent)
    # Each release keeps its own complete trusted bundle. Upgrade the updater
    # itself from the TARGET release, so future protocol changes take effect.
    if not root.exists():
        staging = root.with_name("." + version + ".staging")
        if staging.exists():
            shutil.rmtree(staging)
        shutil.copytree(bundle.root, staging, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        staging.chmod(0o700)
        staging.rename(root)
    for name, text in (("service", SERVICE.format(directory=directory)), ("timer", TIMER)):
        path = runner.path("/etc/systemd/system/umiak-update." + name)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        write_secret(temporary, text)
        temporary.chmod(0o644)
        temporary.replace(path)
    runner.run(["systemctl", "daemon-reload"])
    runner.run(["systemctl", "enable", "--now", "umiak-update.timer"])


def remove(runner):
    if not runner.path("/etc/systemd/system/umiak-update.timer").exists():
        return
    runner.run(["systemctl", "disable", "--now", "umiak-update.timer"])
    for name in ("service", "timer"):
        runner.path("/etc/systemd/system/umiak-update." + name).unlink(missing_ok=True)
    runner.run(["systemctl", "daemon-reload"])
