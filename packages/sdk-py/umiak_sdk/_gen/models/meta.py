from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.meta_auth_mode import MetaAuthMode
from ..models.meta_preview_scheme import MetaPreviewScheme
from ..models.meta_tenancy import MetaTenancy
from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.meta_oidc_type_0 import MetaOidcType0
    from ..models.meta_ssh import MetaSsh


T = TypeVar("T", bound="Meta")


@_attrs_define
class Meta:
    """
    Attributes:
        api_url (str):  Example: https://api.example.com.
        api_version (str):  Example: v1.
        app_url (str):  Example: https://app.example.com.
        build (str): Build of the api Example: 1.4.0+3f2c1a9.
        latest_cli_version (None | str):  Example: 0.5.1.
        min_cli_version (None | str): Older CLIs warn and keep working Example: 0.4.0.
        oidc (MetaOidcType0 | None): Keycloak for people (device flow of `umiak login`); null when only team keys work
        ssh (MetaSsh):
        umiak_domain (str): Domain of published ports: <previewScheme>://<slug>-<port>.<umiakDomain>[:previewPort]
            Example: umiak.example.com.
        auth_mode (MetaAuthMode | Unset):
        preview_port (int | Unset): Public preview listener port; omit from URLs when it is the scheme default
        preview_scheme (MetaPreviewScheme | Unset): Scheme of published port URLs; absent on older servers means https
        tenancy (MetaTenancy | Unset): Presentation model for this deployment. Missing on older servers means teams;
            independent of credential kind.
    """

    api_url: str
    api_version: str
    app_url: str
    build: str
    latest_cli_version: None | str
    min_cli_version: None | str
    oidc: MetaOidcType0 | None
    ssh: MetaSsh
    umiak_domain: str
    auth_mode: MetaAuthMode | Unset = UNSET
    preview_port: int | Unset = UNSET
    preview_scheme: MetaPreviewScheme | Unset = UNSET
    tenancy: MetaTenancy | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.meta_oidc_type_0 import MetaOidcType0  # noqa: PLC0415

        api_url = self.api_url

        api_version = self.api_version

        app_url = self.app_url

        build = self.build

        latest_cli_version: None | str
        latest_cli_version = self.latest_cli_version

        min_cli_version: None | str
        min_cli_version = self.min_cli_version

        oidc: dict[str, Any] | None
        if isinstance(self.oidc, MetaOidcType0):
            oidc = self.oidc.to_dict()
        else:
            oidc = self.oidc

        ssh = self.ssh.to_dict()

        umiak_domain = self.umiak_domain

        auth_mode: str | Unset = UNSET
        if not isinstance(self.auth_mode, Unset):
            auth_mode = self.auth_mode.value

        preview_port = self.preview_port

        preview_scheme: str | Unset = UNSET
        if not isinstance(self.preview_scheme, Unset):
            preview_scheme = self.preview_scheme.value

        tenancy: str | Unset = UNSET
        if not isinstance(self.tenancy, Unset):
            tenancy = self.tenancy.value

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "apiUrl": api_url,
                "apiVersion": api_version,
                "appUrl": app_url,
                "build": build,
                "latestCliVersion": latest_cli_version,
                "minCliVersion": min_cli_version,
                "oidc": oidc,
                "ssh": ssh,
                "umiakDomain": umiak_domain,
            }
        )
        if auth_mode is not UNSET:
            field_dict["authMode"] = auth_mode
        if preview_port is not UNSET:
            field_dict["previewPort"] = preview_port
        if preview_scheme is not UNSET:
            field_dict["previewScheme"] = preview_scheme
        if tenancy is not UNSET:
            field_dict["tenancy"] = tenancy

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.meta_oidc_type_0 import MetaOidcType0  # noqa: PLC0415
        from ..models.meta_ssh import MetaSsh  # noqa: PLC0415

        d = dict(src_dict)
        api_url = d.pop("apiUrl")

        api_version = d.pop("apiVersion")

        app_url = d.pop("appUrl")

        build = d.pop("build")

        def _parse_latest_cli_version(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        latest_cli_version = _parse_latest_cli_version(d.pop("latestCliVersion"))

        def _parse_min_cli_version(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        min_cli_version = _parse_min_cli_version(d.pop("minCliVersion"))

        def _parse_oidc(data: object) -> MetaOidcType0 | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                oidc_type_0 = MetaOidcType0.from_dict(data)

                return oidc_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(MetaOidcType0 | None, data)

        oidc = _parse_oidc(d.pop("oidc"))

        ssh = MetaSsh.from_dict(d.pop("ssh"))

        umiak_domain = d.pop("umiakDomain")

        _auth_mode = d.pop("authMode", UNSET)
        auth_mode: MetaAuthMode | Unset
        if isinstance(_auth_mode, Unset):
            auth_mode = UNSET
        else:
            auth_mode = MetaAuthMode(_auth_mode)

        preview_port = d.pop("previewPort", UNSET)

        _preview_scheme = d.pop("previewScheme", UNSET)
        preview_scheme: MetaPreviewScheme | Unset
        if isinstance(_preview_scheme, Unset):
            preview_scheme = UNSET
        else:
            preview_scheme = MetaPreviewScheme(_preview_scheme)

        _tenancy = d.pop("tenancy", UNSET)
        tenancy: MetaTenancy | Unset
        if isinstance(_tenancy, Unset):
            tenancy = UNSET
        else:
            tenancy = MetaTenancy(_tenancy)

        meta = cls(
            api_url=api_url,
            api_version=api_version,
            app_url=app_url,
            build=build,
            latest_cli_version=latest_cli_version,
            min_cli_version=min_cli_version,
            oidc=oidc,
            ssh=ssh,
            umiak_domain=umiak_domain,
            auth_mode=auth_mode,
            preview_port=preview_port,
            preview_scheme=preview_scheme,
            tenancy=tenancy,
        )

        meta.additional_properties = d
        return meta

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
