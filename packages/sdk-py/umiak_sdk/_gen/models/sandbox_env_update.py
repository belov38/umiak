from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.sandbox_env_update_env import SandboxEnvUpdateEnv
    from ..models.sandbox_env_update_secret_files_item import SandboxEnvUpdateSecretFilesItem


T = TypeVar("T", bound="SandboxEnvUpdate")


@_attrs_define
class SandboxEnvUpdate:
    """
    Attributes:
        delivered (bool): The running agent got the new sets; false when the sandbox is not ready or the agent is
            unreachable (they are applied at the next resume). New commands see them, running ones do not
        env (SandboxEnvUpdateEnv):
        secret_files (list[SandboxEnvUpdateSecretFilesItem]):
        secret_keys (list[str]): Names of the secret variables (values never)
    """

    delivered: bool
    env: SandboxEnvUpdateEnv
    secret_files: list[SandboxEnvUpdateSecretFilesItem]
    secret_keys: list[str]
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        delivered = self.delivered

        env = self.env.to_dict()

        secret_files = []
        for secret_files_item_data in self.secret_files:
            secret_files_item = secret_files_item_data.to_dict()
            secret_files.append(secret_files_item)

        secret_keys = self.secret_keys

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "delivered": delivered,
                "env": env,
                "secretFiles": secret_files,
                "secretKeys": secret_keys,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.sandbox_env_update_env import SandboxEnvUpdateEnv  # noqa: PLC0415
        from ..models.sandbox_env_update_secret_files_item import SandboxEnvUpdateSecretFilesItem  # noqa: PLC0415

        d = dict(src_dict)
        delivered = d.pop("delivered")

        env = SandboxEnvUpdateEnv.from_dict(d.pop("env"))

        secret_files = []
        _secret_files = d.pop("secretFiles")
        for secret_files_item_data in _secret_files:
            secret_files_item = SandboxEnvUpdateSecretFilesItem.from_dict(secret_files_item_data)

            secret_files.append(secret_files_item)

        secret_keys = cast(list[str], d.pop("secretKeys"))

        sandbox_env_update = cls(
            delivered=delivered,
            env=env,
            secret_files=secret_files,
            secret_keys=secret_keys,
        )

        sandbox_env_update.additional_properties = d
        return sandbox_env_update

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
