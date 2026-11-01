from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.command_input_request_encoding import CommandInputRequestEncoding
from ..types import UNSET, Unset

T = TypeVar("T", bound="CommandInputRequest")


@_attrs_define
class CommandInputRequest:
    """
    Attributes:
        data (str): Bytes to write ("" with closeStdin)
        close_stdin (bool | Unset): Close stdin after the data (not for PTY: send ^D)
        encoding (CommandInputRequestEncoding | Unset):
        seq (int | Unset): Order of this chunk within sessionId, from 1; repeats (seq <= last) are dropped
        session_id (str | Unset): Writer id; with seq a repeat is applied once
    """

    data: str
    close_stdin: bool | Unset = UNSET
    encoding: CommandInputRequestEncoding | Unset = UNSET
    seq: int | Unset = UNSET
    session_id: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        data = self.data

        close_stdin = self.close_stdin

        encoding: str | Unset = UNSET
        if not isinstance(self.encoding, Unset):
            encoding = self.encoding.value

        seq = self.seq

        session_id = self.session_id

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "data": data,
            }
        )
        if close_stdin is not UNSET:
            field_dict["closeStdin"] = close_stdin
        if encoding is not UNSET:
            field_dict["encoding"] = encoding
        if seq is not UNSET:
            field_dict["seq"] = seq
        if session_id is not UNSET:
            field_dict["sessionId"] = session_id

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        data = d.pop("data")

        close_stdin = d.pop("closeStdin", UNSET)

        _encoding = d.pop("encoding", UNSET)
        encoding: CommandInputRequestEncoding | Unset
        if isinstance(_encoding, Unset):
            encoding = UNSET
        else:
            encoding = CommandInputRequestEncoding(_encoding)

        seq = d.pop("seq", UNSET)

        session_id = d.pop("sessionId", UNSET)

        command_input_request = cls(
            data=data,
            close_stdin=close_stdin,
            encoding=encoding,
            seq=seq,
            session_id=session_id,
        )

        return command_input_request
