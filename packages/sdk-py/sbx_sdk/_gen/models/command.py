from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.command_mode import CommandMode
from ..models.command_status import CommandStatus

if TYPE_CHECKING:
    from ..models.command_streams_type_0 import CommandStreamsType0
    from ..models.labels import Labels


T = TypeVar("T", bound="Command")


@_attrs_define
class Command:
    """A process started in a sandbox (S7 §9.6)

    Attributes:
        argv (list[str] | None):
        command (None | str): Shell command line (first 64 KiB); null for argv
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        created_by (None | str): The user (`usr_...`) who started it; null for a team key
        created_by_key (None | str): The team key (`key_...`) that started it; null for a person
        cwd (None | str):
        ended_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        env_keys (list[str]): Names of the command's env (never values)
        exit_code (int | None):
        id (str):  Example: cmd_01jbx2v7d3m6c8q9w0e4r5t6y7.
        mode (CommandMode):
        output_truncated (None | str): Why output is missing: `disk_full` when the agent dropped output because the
            sandbox disk was full (stream ends count only the bytes written); null otherwise. Known from the agent while the
            sandbox is ready and in the sync answer; null when unknown
        pid (int | None):
        reason (None | str): Why it ended: none, signal, timeout, oom, pty_idle, reboot, shim_lost, start_failed
        sandbox_id (str):  Example: sb_01jbx4q3m7f8r2t6v9w0y1z2a3.
        signal (None | str):
        started_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        status (CommandStatus):
        streams (CommandStreamsType0 | None): Output sizes: live from the agent while the sandbox is ready, else the
            stored totals; null when unknown
        tags (Labels): Free-form string labels: up to 64, keys up to 128 and values up to 256 characters Example:
            {'session': '42'}.
        timeout_seconds (int | None):
        user (str):
    """

    argv: list[str] | None
    command: None | str
    created_at: datetime.datetime
    created_by: None | str
    created_by_key: None | str
    cwd: None | str
    ended_at: datetime.datetime | None
    env_keys: list[str]
    exit_code: int | None
    id: str
    mode: CommandMode
    output_truncated: None | str
    pid: int | None
    reason: None | str
    sandbox_id: str
    signal: None | str
    started_at: datetime.datetime | None
    status: CommandStatus
    streams: CommandStreamsType0 | None
    tags: Labels
    timeout_seconds: int | None
    user: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.command_streams_type_0 import CommandStreamsType0  # noqa: PLC0415

        argv: list[str] | None
        if isinstance(self.argv, list):
            argv = self.argv

        else:
            argv = self.argv

        command: None | str
        command = self.command

        created_at = self.created_at.isoformat()

        created_by: None | str
        created_by = self.created_by

        created_by_key: None | str
        created_by_key = self.created_by_key

        cwd: None | str
        cwd = self.cwd

        ended_at: None | str
        if isinstance(self.ended_at, datetime.datetime):
            ended_at = self.ended_at.isoformat()
        else:
            ended_at = self.ended_at

        env_keys = self.env_keys

        exit_code: int | None
        exit_code = self.exit_code

        id = self.id

        mode = self.mode.value

        output_truncated: None | str
        output_truncated = self.output_truncated

        pid: int | None
        pid = self.pid

        reason: None | str
        reason = self.reason

        sandbox_id = self.sandbox_id

        signal: None | str
        signal = self.signal

        started_at: None | str
        if isinstance(self.started_at, datetime.datetime):
            started_at = self.started_at.isoformat()
        else:
            started_at = self.started_at

        status = self.status.value

        streams: dict[str, Any] | None
        if isinstance(self.streams, CommandStreamsType0):
            streams = self.streams.to_dict()
        else:
            streams = self.streams

        tags = self.tags.to_dict()

        timeout_seconds: int | None
        timeout_seconds = self.timeout_seconds

        user = self.user

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "argv": argv,
                "command": command,
                "createdAt": created_at,
                "createdBy": created_by,
                "createdByKey": created_by_key,
                "cwd": cwd,
                "endedAt": ended_at,
                "envKeys": env_keys,
                "exitCode": exit_code,
                "id": id,
                "mode": mode,
                "outputTruncated": output_truncated,
                "pid": pid,
                "reason": reason,
                "sandboxId": sandbox_id,
                "signal": signal,
                "startedAt": started_at,
                "status": status,
                "streams": streams,
                "tags": tags,
                "timeoutSeconds": timeout_seconds,
                "user": user,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.command_streams_type_0 import CommandStreamsType0  # noqa: PLC0415
        from ..models.labels import Labels  # noqa: PLC0415

        d = dict(src_dict)

        def _parse_argv(data: object) -> list[str] | None:
            if data is None:
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                argv_type_0 = cast(list[str], data)

                return argv_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[str] | None, data)

        argv = _parse_argv(d.pop("argv"))

        def _parse_command(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        command = _parse_command(d.pop("command"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        def _parse_created_by(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        created_by = _parse_created_by(d.pop("createdBy"))

        def _parse_created_by_key(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        created_by_key = _parse_created_by_key(d.pop("createdByKey"))

        def _parse_cwd(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        cwd = _parse_cwd(d.pop("cwd"))

        def _parse_ended_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                ended_at_type_0 = datetime.datetime.fromisoformat(data)

                return ended_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        ended_at = _parse_ended_at(d.pop("endedAt"))

        env_keys = cast(list[str], d.pop("envKeys"))

        def _parse_exit_code(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        exit_code = _parse_exit_code(d.pop("exitCode"))

        id = d.pop("id")

        mode = CommandMode(d.pop("mode"))

        def _parse_output_truncated(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        output_truncated = _parse_output_truncated(d.pop("outputTruncated"))

        def _parse_pid(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        pid = _parse_pid(d.pop("pid"))

        def _parse_reason(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        reason = _parse_reason(d.pop("reason"))

        sandbox_id = d.pop("sandboxId")

        def _parse_signal(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        signal = _parse_signal(d.pop("signal"))

        def _parse_started_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                started_at_type_0 = datetime.datetime.fromisoformat(data)

                return started_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        started_at = _parse_started_at(d.pop("startedAt"))

        status = CommandStatus(d.pop("status"))

        def _parse_streams(data: object) -> CommandStreamsType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                streams_type_0 = CommandStreamsType0.from_dict(data)

                return streams_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(CommandStreamsType0 | None, data)

        streams = _parse_streams(d.pop("streams"))

        tags = Labels.from_dict(d.pop("tags"))

        def _parse_timeout_seconds(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        timeout_seconds = _parse_timeout_seconds(d.pop("timeoutSeconds"))

        user = d.pop("user")

        command = cls(
            argv=argv,
            command=command,
            created_at=created_at,
            created_by=created_by,
            created_by_key=created_by_key,
            cwd=cwd,
            ended_at=ended_at,
            env_keys=env_keys,
            exit_code=exit_code,
            id=id,
            mode=mode,
            output_truncated=output_truncated,
            pid=pid,
            reason=reason,
            sandbox_id=sandbox_id,
            signal=signal,
            started_at=started_at,
            status=status,
            streams=streams,
            tags=tags,
            timeout_seconds=timeout_seconds,
            user=user,
        )

        command.additional_properties = d
        return command

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
