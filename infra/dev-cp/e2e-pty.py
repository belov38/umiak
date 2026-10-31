#!/usr/bin/env python3
"""Drives `sbx shell` in a pseudo-terminal for e2e.sh. Dev only.

    e2e-pty.py <sbx> <sandbox>

Starts the shell at 40x120, checks the terminal and its size, resizes to 50x132
(SIGWINCH), checks the new size and exits the shell with code 5. Prints
"pty ok" and exits 0 when everything matched and sbx exited with 5.
"""

import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(sys.argv[1], [sys.argv[1], "shell", sys.argv[2]])
    out = bytearray()

    def setsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def until(pattern, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if re.search(pattern, out):
                return True
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return bool(re.search(pattern, out))
                if not d:
                    return bool(re.search(pattern, out))
                out.extend(d)
        return False

    setsize(40, 120)
    ok = until(rb"\$ ", 30)
    os.write(fd, b"echo TTY=$(tty) SIZE1=$(stty size) M=$((6*7))\r")
    ok = until(rb"SIZE1=\d+ \d+ M=42", 15) and ok
    setsize(50, 132)
    time.sleep(1)
    os.write(fd, b"echo SIZE2=$(stty size)\r")
    ok = until(rb"SIZE2=\d+ \d+", 15) and ok
    os.write(fd, b"exit 5\r")
    until(rb"\Z.", 10)
    _, st = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(st)
    text = out.decode(errors="replace")
    tty = re.search(r"TTY=(/dev/\S+)", text)
    s1 = re.search(r"SIZE1=(\d+ \d+)", text)
    s2 = re.search(r"SIZE2=(\d+ \d+)", text)
    got = (tty and tty.group(1), s1 and s1.group(1), s2 and s2.group(1), code)
    print(f"tty={got[0]} size1={got[1]} size2={got[2]} exit={code}")
    if ok and got[0] and got[0].startswith("/dev/pts/") and got[1:] == ("40 120", "50 132", 5):
        print("pty ok")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
