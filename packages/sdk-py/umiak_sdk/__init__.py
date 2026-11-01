"""Python SDK of the umiak public API (S7 §15.3).

    from umiak_sdk import Umiak

    with Umiak(base_url="https://api.example.com", api_key="umiak_...") as umiak:
        sb = umiak.sandboxes.create(template="linux", wait=True)
        r = sb.exec("echo hi")
        for ev in sb.run("make build"):
            ...
        sb.files.write_text("notes.txt", "hi")
        sb.delete()

``AsyncUmiak`` has the same methods as coroutines and async iterators.
API resources are the generated models of ``umiak_sdk.models``; ``umiak.raw`` is
the generated client (``umiak_sdk._gen.api``) with the same transport.
"""

from ._async import (
    AsyncCommand,
    AsyncFiles,
    AsyncPorts,
    AsyncSandbox,
    AsyncSandboxes,
    AsyncUmiak,
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
    UmiakError,
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
from ._sync import Command, Files, Ports, Sandbox, Sandboxes, Umiak, Snapshots

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
    "AsyncUmiak",
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
    "Umiak",
    "UmiakError",
    "Snapshots",
    "TruncatedEvent",
    "models",
]
