from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..models.start_command_request_encoding import StartCommandRequestEncoding
from ..models.start_command_request_mode import StartCommandRequestMode
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.labels import Labels
    from ..models.start_command_request_env import StartCommandRequestEnv


T = TypeVar("T", bound="StartCommandRequest")


@_attrs_define
class StartCommandRequest:
    """
    Attributes:
        argv (list[str] | None | Unset): Program and arguments, run without a shell Example: ['node', '--version'].
        command (str | Unset): Shell command line, run by `bash -lc` (up to 256 KiB). Exactly one of command and argv.
            Example: npm test.
        cwd (None | str | Unset): Working directory; relative to the user's home (default)
        encoding (StartCommandRequestEncoding | Unset): Output in frames and the sync answer: utf8 (default; invalid
            bytes become U+FFFD) or base64
        env (StartCommandRequestEnv | Unset):
        mode (StartCommandRequestMode | Unset): `sync` (default): 200 with the output once the command exits. `stream`:
            200 NDJSON frames. `detached`: 201 Command right after the start.
        stdin (bool | Unset): Keep stdin open for POST .../input (needs the agent capability process.stdin)
        tags (Labels | Unset): Free-form string labels: up to 64, keys up to 128 and values up to 256 characters
            Example: {'session': '42'}.
        timeout_seconds (int | None | Unset): Process timeout (status timed_out). sync: default 60, at most 600, null
            not allowed. stream and detached: default none (null).
        user (str | Unset): Guest user (default: the login user of the sandbox's template, `user` unless the template
            sets another; `root` is allowed)
    """

    argv: list[str] | None | Unset = UNSET
    command: str | Unset = UNSET
    cwd: None | str | Unset = UNSET
    encoding: StartCommandRequestEncoding | Unset = UNSET
    env: StartCommandRequestEnv | Unset = UNSET
    mode: StartCommandRequestMode | Unset = UNSET
    stdin: bool | Unset = UNSET
    tags: Labels | Unset = UNSET
    timeout_seconds: int | None | Unset = UNSET
    user: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        argv: list[str] | None | Unset
        if isinstance(self.argv, Unset):
            argv = UNSET
        elif isinstance(self.argv, list):
            argv = self.argv

        else:
            argv = self.argv

        command = self.command

        cwd: None | str | Unset
        if isinstance(self.cwd, Unset):
            cwd = UNSET
        else:
            cwd = self.cwd

        encoding: str | Unset = UNSET
        if not isinstance(self.encoding, Unset):
            encoding = self.encoding.value

        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        mode: str | Unset = UNSET
        if not isinstance(self.mode, Unset):
            mode = self.mode.value

        stdin = self.stdin

        tags: dict[str, Any] | Unset = UNSET
        if not isinstance(self.tags, Unset):
            tags = self.tags.to_dict()

        timeout_seconds: int | None | Unset
        if isinstance(self.timeout_seconds, Unset):
            timeout_seconds = UNSET
        else:
            timeout_seconds = self.timeout_seconds

        user = self.user

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if argv is not UNSET:
            field_dict["argv"] = argv
        if command is not UNSET:
            field_dict["command"] = command
        if cwd is not UNSET:
            field_dict["cwd"] = cwd
        if encoding is not UNSET:
            field_dict["encoding"] = encoding
        if env is not UNSET:
            field_dict["env"] = env
        if mode is not UNSET:
            field_dict["mode"] = mode
        if stdin is not UNSET:
            field_dict["stdin"] = stdin
        if tags is not UNSET:
            field_dict["tags"] = tags
        if timeout_seconds is not UNSET:
            field_dict["timeoutSeconds"] = timeout_seconds
        if user is not UNSET:
            field_dict["user"] = user

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.labels import Labels  # noqa: PLC0415
        from ..models.start_command_request_env import StartCommandRequestEnv  # noqa: PLC0415

        d = dict(src_dict)

        def _parse_argv(data: object) -> list[str] | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                argv_type_0 = cast(list[str], data)

                return argv_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[str] | None | Unset, data)

        argv = _parse_argv(d.pop("argv", UNSET))

        command = d.pop("command", UNSET)

        def _parse_cwd(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        cwd = _parse_cwd(d.pop("cwd", UNSET))

        _encoding = d.pop("encoding", UNSET)
        encoding: StartCommandRequestEncoding | Unset
        if isinstance(_encoding, Unset):
            encoding = UNSET
        else:
            encoding = StartCommandRequestEncoding(_encoding)

        _env = d.pop("env", UNSET)
        env: StartCommandRequestEnv | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = StartCommandRequestEnv.from_dict(_env)

        _mode = d.pop("mode", UNSET)
        mode: StartCommandRequestMode | Unset
        if isinstance(_mode, Unset):
            mode = UNSET
        else:
            mode = StartCommandRequestMode(_mode)

        stdin = d.pop("stdin", UNSET)

        _tags = d.pop("tags", UNSET)
        tags: Labels | Unset
        if isinstance(_tags, Unset):
            tags = UNSET
        else:
            tags = Labels.from_dict(_tags)

        def _parse_timeout_seconds(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        timeout_seconds = _parse_timeout_seconds(d.pop("timeoutSeconds", UNSET))

        user = d.pop("user", UNSET)

        start_command_request = cls(
            argv=argv,
            command=command,
            cwd=cwd,
            encoding=encoding,
            env=env,
            mode=mode,
            stdin=stdin,
            tags=tags,
            timeout_seconds=timeout_seconds,
            user=user,
        )

        return start_command_request
