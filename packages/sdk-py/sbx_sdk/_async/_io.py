"""I/O primitives of the asyncio facade. scripts/gen.py rewrites the rest of
``sbx_sdk/_async`` into ``sbx_sdk/_sync``; this module is written by hand on
both sides (sleep, locks, the ``sbx auth token`` subprocess).
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import signal
from collections.abc import Mapping, Sequence
from typing import Any

from .._credentials import AUTH_COMMAND_TIMEOUT, auth_command_failure

sleep = asyncio.sleep
Lock = asyncio.Lock


async def maybe_await(value: Any) -> Any:
    """The value, awaited if a token_provider returned an awaitable."""
    if inspect.isawaitable(value):
        return await value
    return value


def kill_tree(pid: int) -> None:
    """SIGKILL to the command and its children (its own session on POSIX)."""
    with contextlib.suppress(OSError):
        if hasattr(os, "killpg"):
            os.killpg(pid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGTERM)


async def run_auth_command(
    cmd: Sequence[str], env: Mapping[str, str], timeout: float = AUTH_COMMAND_TIMEOUT
) -> str:
    """stdout of ``sbx auth token --json``; SbxError when it gives no token.
    A command that outlives ``timeout`` is killed with its children."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(env),
            start_new_session=True,
        )
    except FileNotFoundError:
        raise auth_command_failure(cmd, not_found=True) from None
    except OSError as err:
        raise auth_command_failure(cmd, stderr=str(err)) from err
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except BaseException as e:
        kill_tree(proc.pid)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(proc.wait(), 1.0)
        if isinstance(e, TimeoutError):
            raise auth_command_failure(cmd, timeout=timeout) from None
        raise
    if proc.returncode != 0:
        raise auth_command_failure(
            cmd, returncode=proc.returncode, stderr=err.decode("utf-8", "replace")
        )
    return out.decode("utf-8", "replace")
