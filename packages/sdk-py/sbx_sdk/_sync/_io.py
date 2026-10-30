"""I/O primitives of the blocking facade, the counterpart of
``sbx_sdk/_async/_io.py`` (written by hand; not generated).
"""

from __future__ import annotations

import subprocess
import threading
import time
from collections.abc import Mapping, Sequence
from typing import Any

from .._async._io import kill_tree
from .._credentials import AUTH_COMMAND_TIMEOUT, auth_command_failure

sleep = time.sleep
Lock = threading.Lock


def maybe_await(value: Any) -> Any:
    return value


def run_auth_command(
    cmd: Sequence[str], env: Mapping[str, str], timeout: float = AUTH_COMMAND_TIMEOUT
) -> str:
    """stdout of ``sbx auth token --json``; SbxError when it gives no token.
    A command that outlives ``timeout`` is killed with its children."""
    try:
        proc = subprocess.Popen(
            list(cmd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=dict(env),
            start_new_session=True,
        )
    except FileNotFoundError:
        raise auth_command_failure(cmd, not_found=True) from None
    except OSError as err:
        raise auth_command_failure(cmd, stderr=str(err)) from err
    try:
        out, err = proc.communicate(timeout=timeout)
    except BaseException as e:
        kill_tree(proc.pid)
        try:
            proc.wait(1.0)
        except subprocess.TimeoutExpired:
            pass
        if isinstance(e, subprocess.TimeoutExpired):
            raise auth_command_failure(cmd, timeout=timeout) from None
        raise
    finally:
        for f in (proc.stdout, proc.stderr):
            if f is not None:
                f.close()
    if proc.returncode != 0:
        raise auth_command_failure(
            cmd, returncode=proc.returncode, stderr=err.decode("utf-8", "replace")
        )
    return out.decode("utf-8", "replace")
