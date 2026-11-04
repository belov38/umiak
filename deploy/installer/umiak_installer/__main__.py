import os
import sys

# Defence in depth: children of the installer (pvesh set /cluster/sdn, apt, systemctl)
# inherit the umask, and a 077 here makes PVE write dnsmasq/dbus configs as 0600,
# unreadable by messagebus. Secret files and directories never rely on the umask:
# they get explicit modes (pve.write_secret, pve.private_dir).
os.umask(0o022)

from .main import run  # noqa: E402

sys.exit(run())
