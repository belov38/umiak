from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.env_replace_request_secrets import EnvReplaceRequestSecrets
    from ..models.env_vars import EnvVars
    from ..models.secret_file_input import SecretFileInput


T = TypeVar("T", bound="EnvReplaceRequest")


@_attrs_define
class EnvReplaceRequest:
    """Each given set replaces its set whole; the others stay

    Attributes:
        env (EnvVars | Unset): Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without NUL,
            256 KiB per set. `UMIAK_` is reserved except UMIAK_API_KEY, UMIAK_API_URL, UMIAK_TEAM, UMIAK_PROFILE. Values
            with a newline are not visible in SSH sessions.
        secret_files (list[SecretFileInput] | Unset):
        secrets (EnvReplaceRequestSecrets | Unset):
    """

    env: EnvVars | Unset = UNSET
    secret_files: list[SecretFileInput] | Unset = UNSET
    secrets: EnvReplaceRequestSecrets | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        secret_files: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.secret_files, Unset):
            secret_files = []
            for secret_files_item_data in self.secret_files:
                secret_files_item = secret_files_item_data.to_dict()
                secret_files.append(secret_files_item)

        secrets: dict[str, Any] | Unset = UNSET
        if not isinstance(self.secrets, Unset):
            secrets = self.secrets.to_dict()

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if env is not UNSET:
            field_dict["env"] = env
        if secret_files is not UNSET:
            field_dict["secretFiles"] = secret_files
        if secrets is not UNSET:
            field_dict["secrets"] = secrets

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.env_replace_request_secrets import EnvReplaceRequestSecrets  # noqa: PLC0415
        from ..models.env_vars import EnvVars  # noqa: PLC0415
        from ..models.secret_file_input import SecretFileInput  # noqa: PLC0415

        d = dict(src_dict)
        _env = d.pop("env", UNSET)
        env: EnvVars | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = EnvVars.from_dict(_env)

        _secret_files = d.pop("secretFiles", UNSET)
        secret_files: list[SecretFileInput] | Unset = UNSET
        if _secret_files is not UNSET:
            secret_files = []
            for secret_files_item_data in _secret_files:
                secret_files_item = SecretFileInput.from_dict(secret_files_item_data)

                secret_files.append(secret_files_item)

        _secrets = d.pop("secrets", UNSET)
        secrets: EnvReplaceRequestSecrets | Unset
        if isinstance(_secrets, Unset):
            secrets = UNSET
        else:
            secrets = EnvReplaceRequestSecrets.from_dict(_secrets)

        env_replace_request = cls(
            env=env,
            secret_files=secret_files,
            secrets=secrets,
        )

        return env_replace_request
