from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.command_signal_request_signal import CommandSignalRequestSignal

T = TypeVar("T", bound="CommandSignalRequest")


@_attrs_define
class CommandSignalRequest:
    """
    Attributes:
        signal (CommandSignalRequestSignal):
    """

    signal: CommandSignalRequestSignal

    def to_dict(self) -> dict[str, Any]:
        signal = self.signal.value

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "signal": signal,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        signal = CommandSignalRequestSignal(d.pop("signal"))

        command_signal_request = cls(
            signal=signal,
        )

        return command_signal_request
