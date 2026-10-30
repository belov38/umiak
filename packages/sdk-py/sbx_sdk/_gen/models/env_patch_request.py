from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.env_patch_request_secrets import EnvPatchRequestSecrets
    from ..models.env_vars_patch import EnvVarsPatch
    from ..models.secret_files_patch import SecretFilesPatch


T = TypeVar("T", bound="EnvPatchRequest")


@_attrs_define
class EnvPatchRequest:
    """Merge by key: a value sets the key, null deletes it; files by name

    Attributes:
        env (EnvVarsPatch | Unset): Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without
            NUL, 256 KiB per set. `SBX_` is reserved except SBX_API_KEY, SBX_API_URL, SBX_TEAM, SBX_PROFILE. Values with a
            newline are not visible in SSH sessions. Merged by key: null deletes the key.
        secret_files (SecretFilesPatch | Unset): Secret files by name: a file replaces the one with that name, null
            deletes it
        secrets (EnvPatchRequestSecrets | Unset):
    """

    env: EnvVarsPatch | Unset = UNSET
    secret_files: SecretFilesPatch | Unset = UNSET
    secrets: EnvPatchRequestSecrets | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        secret_files: dict[str, Any] | Unset = UNSET
        if not isinstance(self.secret_files, Unset):
            secret_files = self.secret_files.to_dict()

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
        from ..models.env_patch_request_secrets import EnvPatchRequestSecrets  # noqa: PLC0415
        from ..models.env_vars_patch import EnvVarsPatch  # noqa: PLC0415
        from ..models.secret_files_patch import SecretFilesPatch  # noqa: PLC0415

        d = dict(src_dict)
        _env = d.pop("env", UNSET)
        env: EnvVarsPatch | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = EnvVarsPatch.from_dict(_env)

        _secret_files = d.pop("secretFiles", UNSET)
        secret_files: SecretFilesPatch | Unset
        if isinstance(_secret_files, Unset):
            secret_files = UNSET
        else:
            secret_files = SecretFilesPatch.from_dict(_secret_files)

        _secrets = d.pop("secrets", UNSET)
        secrets: EnvPatchRequestSecrets | Unset
        if isinstance(_secrets, Unset):
            secrets = UNSET
        else:
            secrets = EnvPatchRequestSecrets.from_dict(_secrets)

        env_patch_request = cls(
            env=env,
            secret_files=secret_files,
            secrets=secrets,
        )

        return env_patch_request
