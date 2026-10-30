"""Python SDK of the sbx public API (S7 §15.3).

    from sbx_sdk import Sbx

    with Sbx(base_url="https://api.example.com", api_key="sbx_...") as sbx:
        sb = sbx.sandboxes.create(template="linux", wait=True)
        r = sb.exec("echo hi")
        for ev in sb.run("make build"):
            ...
        sb.files.write_text("notes.txt", "hi")
        sb.delete()

``AsyncSbx`` has the same methods as coroutines and async iterators.
API resources are the generated models of ``sbx_sdk.models``; ``sbx.raw`` is
the generated client (``sbx_sdk._gen.api``) with the same transport.
"""

from ._async import (
    AsyncCommand,
    AsyncFiles,
    AsyncPorts,
    AsyncSandbox,
    AsyncSandboxes,
    AsyncSbx,
    AsyncSnapshots,
)
from ._async.client import SDK_VERSION
from ._errors import (
    AUTH_COMMAND_FAILED,
    NETWORK_ERROR,
    NO_API_URL,
    NO_CREDENTIALS,
    PROTOCOL_ERROR,
    TOKEN_PROVIDER_FAILED,
    UNEXPECTED_RESPONSE,
    WAIT_TIMEOUT,
    SandboxFailedError,
    SbxError,
)
from ._events import (
    EXEC_TAIL_BYTES,
    READY_TIMEOUT,
    STREAM_IDLE_TIMEOUT,
    DownloadResult,
    ExecResult,
    ExitEvent,
    Offsets,
    OutputChunk,
    OutputEvent,
    RunEvent,
    TruncatedEvent,
)
from ._gen import models
from ._sync import Command, Files, Ports, Sandbox, Sandboxes, Sbx, Snapshots

__version__ = SDK_VERSION

__all__ = [
    "AUTH_COMMAND_FAILED",
    "EXEC_TAIL_BYTES",
    "NETWORK_ERROR",
    "NO_API_URL",
    "NO_CREDENTIALS",
    "PROTOCOL_ERROR",
    "READY_TIMEOUT",
    "SDK_VERSION",
    "STREAM_IDLE_TIMEOUT",
    "TOKEN_PROVIDER_FAILED",
    "UNEXPECTED_RESPONSE",
    "WAIT_TIMEOUT",
    "AsyncCommand",
    "AsyncFiles",
    "AsyncPorts",
    "AsyncSandbox",
    "AsyncSandboxes",
    "AsyncSbx",
    "AsyncSnapshots",
    "Command",
    "DownloadResult",
    "ExecResult",
    "ExitEvent",
    "Files",
    "Offsets",
    "OutputChunk",
    "OutputEvent",
    "Ports",
    "RunEvent",
    "Sandbox",
    "SandboxFailedError",
    "Sandboxes",
    "Sbx",
    "SbxError",
    "Snapshots",
    "TruncatedEvent",
    "models",
]
