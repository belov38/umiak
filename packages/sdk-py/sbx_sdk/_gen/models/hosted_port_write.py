from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.hosted_port_write_access import HostedPortWriteAccess
from ..models.hosted_port_write_app_protocol import HostedPortWriteAppProtocol
from ..models.hosted_port_write_block_reason_type_1 import HostedPortWriteBlockReasonType1
from ..models.hosted_port_write_block_reason_type_2_type_1 import (
    HostedPortWriteBlockReasonType2Type1,
)
from ..models.hosted_port_write_block_reason_type_3_type_1 import (
    HostedPortWriteBlockReasonType3Type1,
)
from ..models.hosted_port_write_host_rewrite import HostedPortWriteHostRewrite
from ..types import UNSET, Unset

T = TypeVar("T", bound="HostedPortWrite")


@_attrs_define
class HostedPortWrite:
    """The hosted port; with the token when this call issued one

    Attributes:
        access (HostedPortWriteAccess):
        app_protocol (HostedPortWriteAppProtocol):
        block_reason (HostedPortWriteBlockReasonType1 | HostedPortWriteBlockReasonType2Type1 |
            HostedPortWriteBlockReasonType3Type1 | None):
        blocked (bool): An operator blocked the port: the gateway refuses it, and PUT, rotate-token and DELETE of the
            port are 403 `forbidden` (details.reason `port_blocked`)
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        host_rewrite (HostedPortWriteHostRewrite):
        label (str): `<slug>-<port>`, the first DNS label of the URL Example: quiet-otter-lamp-3000.
        port (int):  Example: 3000.
        url (str):  Example: https://quiet-otter-lamp-3000.sbx.example.com.
        token (str | Unset): Only when this call issued a token (a new token port or a switch to token). It is not
            stored and never shown again: replace a lost one with rotate-token Example: sbxp_....
        url_with_token (str | Unset): `url` + `/?_token=<token>`, with `token`
    """

    access: HostedPortWriteAccess
    app_protocol: HostedPortWriteAppProtocol
    block_reason: (
        HostedPortWriteBlockReasonType1
        | HostedPortWriteBlockReasonType2Type1
        | HostedPortWriteBlockReasonType3Type1
        | None
    )
    blocked: bool
    created_at: datetime.datetime
    host_rewrite: HostedPortWriteHostRewrite
    label: str
    port: int
    url: str
    token: str | Unset = UNSET
    url_with_token: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        access = self.access.value

        app_protocol = self.app_protocol.value

        block_reason: None | str
        if isinstance(self.block_reason, HostedPortWriteBlockReasonType1):
            block_reason = self.block_reason.value
        elif isinstance(self.block_reason, HostedPortWriteBlockReasonType2Type1):
            block_reason = self.block_reason.value
        elif isinstance(self.block_reason, HostedPortWriteBlockReasonType3Type1):
            block_reason = self.block_reason.value
        else:
            block_reason = self.block_reason

        blocked = self.blocked

        created_at = self.created_at.isoformat()

        host_rewrite = self.host_rewrite.value

        label = self.label

        port = self.port

        url = self.url

        token = self.token

        url_with_token = self.url_with_token

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "access": access,
                "appProtocol": app_protocol,
                "blockReason": block_reason,
                "blocked": blocked,
                "createdAt": created_at,
                "hostRewrite": host_rewrite,
                "label": label,
                "port": port,
                "url": url,
            }
        )
        if token is not UNSET:
            field_dict["token"] = token
        if url_with_token is not UNSET:
            field_dict["urlWithToken"] = url_with_token

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        access = HostedPortWriteAccess(d.pop("access"))

        app_protocol = HostedPortWriteAppProtocol(d.pop("appProtocol"))

        def _parse_block_reason(
            data: object,
        ) -> (
            HostedPortWriteBlockReasonType1
            | HostedPortWriteBlockReasonType2Type1
            | HostedPortWriteBlockReasonType3Type1
            | None
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                block_reason_type_1 = HostedPortWriteBlockReasonType1(data)

                return block_reason_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                block_reason_type_2_type_1 = HostedPortWriteBlockReasonType2Type1(data)

                return block_reason_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                block_reason_type_3_type_1 = HostedPortWriteBlockReasonType3Type1(data)

                return block_reason_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                HostedPortWriteBlockReasonType1
                | HostedPortWriteBlockReasonType2Type1
                | HostedPortWriteBlockReasonType3Type1
                | None,
                data,
            )

        block_reason = _parse_block_reason(d.pop("blockReason"))

        blocked = d.pop("blocked")

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        host_rewrite = HostedPortWriteHostRewrite(d.pop("hostRewrite"))

        label = d.pop("label")

        port = d.pop("port")

        url = d.pop("url")

        token = d.pop("token", UNSET)

        url_with_token = d.pop("urlWithToken", UNSET)

        hosted_port_write = cls(
            access=access,
            app_protocol=app_protocol,
            block_reason=block_reason,
            blocked=blocked,
            created_at=created_at,
            host_rewrite=host_rewrite,
            label=label,
            port=port,
            url=url,
            token=token,
            url_with_token=url_with_token,
        )

        hosted_port_write.additional_properties = d
        return hosted_port_write

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
