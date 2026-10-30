from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..models.host_port_request_access import HostPortRequestAccess
from ..models.host_port_request_app_protocol import HostPortRequestAppProtocol
from ..models.host_port_request_host_rewrite import HostPortRequestHostRewrite
from ..types import UNSET, Unset

T = TypeVar("T", bound="HostPortRequest")


@_attrs_define
class HostPortRequest:
    """The full desired settings (PUT): an omitted field takes its default, not the current value

    Attributes:
        access (HostPortRequestAccess | Unset): token (default): a secret link; sso: any signed-in user of the platform;
            public: anyone (the operator may turn public off)
        app_protocol (HostPortRequestAppProtocol | Unset): http1 (default) or h2c (HTTP/2 without TLS, gRPC)
        host_rewrite (HostPortRequestHostRewrite | Unset): preserve (default): the app sees the public Host; localhost:
            Host is rewritten to localhost:<port> for dev servers that check it
    """

    access: HostPortRequestAccess | Unset = UNSET
    app_protocol: HostPortRequestAppProtocol | Unset = UNSET
    host_rewrite: HostPortRequestHostRewrite | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        access: str | Unset = UNSET
        if not isinstance(self.access, Unset):
            access = self.access.value

        app_protocol: str | Unset = UNSET
        if not isinstance(self.app_protocol, Unset):
            app_protocol = self.app_protocol.value

        host_rewrite: str | Unset = UNSET
        if not isinstance(self.host_rewrite, Unset):
            host_rewrite = self.host_rewrite.value

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if access is not UNSET:
            field_dict["access"] = access
        if app_protocol is not UNSET:
            field_dict["appProtocol"] = app_protocol
        if host_rewrite is not UNSET:
            field_dict["hostRewrite"] = host_rewrite

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        _access = d.pop("access", UNSET)
        access: HostPortRequestAccess | Unset
        if isinstance(_access, Unset):
            access = UNSET
        else:
            access = HostPortRequestAccess(_access)

        _app_protocol = d.pop("appProtocol", UNSET)
        app_protocol: HostPortRequestAppProtocol | Unset
        if isinstance(_app_protocol, Unset):
            app_protocol = UNSET
        else:
            app_protocol = HostPortRequestAppProtocol(_app_protocol)

        _host_rewrite = d.pop("hostRewrite", UNSET)
        host_rewrite: HostPortRequestHostRewrite | Unset
        if isinstance(_host_rewrite, Unset):
            host_rewrite = UNSET
        else:
            host_rewrite = HostPortRequestHostRewrite(_host_rewrite)

        host_port_request = cls(
            access=access,
            app_protocol=app_protocol,
            host_rewrite=host_rewrite,
        )

        return host_port_request
