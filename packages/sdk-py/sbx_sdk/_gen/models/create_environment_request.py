from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.create_environment_request_secrets import CreateEnvironmentRequestSecrets
    from ..models.env_vars import EnvVars
    from ..models.repository_input import RepositoryInput
    from ..models.secret_file_input import SecretFileInput


T = TypeVar("T", bound="CreateEnvironmentRequest")


@_attrs_define
class CreateEnvironmentRequest:
    """
    Attributes:
        name (str): Unique in the team: `^[a-z0-9][a-z0-9-]{0,62}$` Example: production.
        env (EnvVars | Unset): Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without NUL,
            256 KiB per set. `SBX_` is reserved except SBX_API_KEY, SBX_API_URL, SBX_TEAM, SBX_PROFILE. Values with a
            newline are not visible in SSH sessions.
        exclude_owner_secrets (bool | Unset): Do not pass the creating user's personal secrets into the sandbox (stored
            only)
        is_default (bool | Unset): Applied to every create of the team that names no environment; the previous default
            stops being one
        repositories (list[RepositoryInput] | Unset): Up to 20 repositories; stored and returned only (cloning comes
            later)
        secret_files (list[SecretFileInput] | Unset):
        secrets (CreateEnvironmentRequestSecrets | Unset):
    """

    name: str
    env: EnvVars | Unset = UNSET
    exclude_owner_secrets: bool | Unset = UNSET
    is_default: bool | Unset = UNSET
    repositories: list[RepositoryInput] | Unset = UNSET
    secret_files: list[SecretFileInput] | Unset = UNSET
    secrets: CreateEnvironmentRequestSecrets | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        name = self.name

        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        exclude_owner_secrets = self.exclude_owner_secrets

        is_default = self.is_default

        repositories: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.repositories, Unset):
            repositories = []
            for repositories_item_data in self.repositories:
                repositories_item = repositories_item_data.to_dict()
                repositories.append(repositories_item)

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

        field_dict.update(
            {
                "name": name,
            }
        )
        if env is not UNSET:
            field_dict["env"] = env
        if exclude_owner_secrets is not UNSET:
            field_dict["excludeOwnerSecrets"] = exclude_owner_secrets
        if is_default is not UNSET:
            field_dict["isDefault"] = is_default
        if repositories is not UNSET:
            field_dict["repositories"] = repositories
        if secret_files is not UNSET:
            field_dict["secretFiles"] = secret_files
        if secrets is not UNSET:
            field_dict["secrets"] = secrets

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_environment_request_secrets import CreateEnvironmentRequestSecrets  # noqa: PLC0415
        from ..models.env_vars import EnvVars  # noqa: PLC0415
        from ..models.repository_input import RepositoryInput  # noqa: PLC0415
        from ..models.secret_file_input import SecretFileInput  # noqa: PLC0415

        d = dict(src_dict)
        name = d.pop("name")

        _env = d.pop("env", UNSET)
        env: EnvVars | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = EnvVars.from_dict(_env)

        exclude_owner_secrets = d.pop("excludeOwnerSecrets", UNSET)

        is_default = d.pop("isDefault", UNSET)

        _repositories = d.pop("repositories", UNSET)
        repositories: list[RepositoryInput] | Unset = UNSET
        if _repositories is not UNSET:
            repositories = []
            for repositories_item_data in _repositories:
                repositories_item = RepositoryInput.from_dict(repositories_item_data)

                repositories.append(repositories_item)

        _secret_files = d.pop("secretFiles", UNSET)
        secret_files: list[SecretFileInput] | Unset = UNSET
        if _secret_files is not UNSET:
            secret_files = []
            for secret_files_item_data in _secret_files:
                secret_files_item = SecretFileInput.from_dict(secret_files_item_data)

                secret_files.append(secret_files_item)

        _secrets = d.pop("secrets", UNSET)
        secrets: CreateEnvironmentRequestSecrets | Unset
        if isinstance(_secrets, Unset):
            secrets = UNSET
        else:
            secrets = CreateEnvironmentRequestSecrets.from_dict(_secrets)

        create_environment_request = cls(
            name=name,
            env=env,
            exclude_owner_secrets=exclude_owner_secrets,
            is_default=is_default,
            repositories=repositories,
            secret_files=secret_files,
            secrets=secrets,
        )

        return create_environment_request
