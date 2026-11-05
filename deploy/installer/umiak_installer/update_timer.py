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
WorkingDirectory=/var/lib/umiak-installer/updater
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
    root = runner.path(ROOT) / "updater"
    private_dir(root)
    # This is host-trusted code copied from a verified bundle, never the CT.
    shutil.copytree(Path(__file__).parent, root / "umiak_installer", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    write_secret(root / "VERSION", bundle.version + "\n")
    for name, text in (("service", SERVICE), ("timer", TIMER)):
        path = runner.path("/etc/systemd/system/umiak-update." + name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o644)
    runner.run(["systemctl", "daemon-reload"])
    runner.run(["systemctl", "enable", "--now", "umiak-update.timer"])


def remove(runner):
    if not runner.path("/etc/systemd/system/umiak-update.timer").exists():
        return
    runner.run(["systemctl", "disable", "--now", "umiak-update.timer"])
    for name in ("service", "timer"):
        runner.path("/etc/systemd/system/umiak-update." + name).unlink(missing_ok=True)
    runner.run(["systemctl", "daemon-reload"])
