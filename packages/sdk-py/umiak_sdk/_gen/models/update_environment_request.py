from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.env_vars_patch import EnvVarsPatch
    from ..models.repository_input import RepositoryInput
    from ..models.secret_files_patch import SecretFilesPatch
    from ..models.update_environment_request_secrets import UpdateEnvironmentRequestSecrets


T = TypeVar("T", bound="UpdateEnvironmentRequest")


@_attrs_define
class UpdateEnvironmentRequest:
    """Sets merge by key (null deletes a key or a file); repositories are replaced; revision + 1

    Attributes:
        env (EnvVarsPatch | Unset): Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without
            NUL, 256 KiB per set. `UMIAK_` is reserved except UMIAK_API_KEY, UMIAK_API_URL, UMIAK_TEAM, UMIAK_PROFILE.
            Values with a newline are not visible in SSH sessions. Merged by key: null deletes the key.
        exclude_owner_secrets (bool | Unset):
        is_default (bool | Unset):
        name (str | Unset): Unique in the team: `^[a-z0-9][a-z0-9-]{0,62}$` Example: production.
        repositories (list[RepositoryInput] | Unset): Replaces the list whole
        secret_files (SecretFilesPatch | Unset): Secret files by name: a file replaces the one with that name, null
            deletes it
        secrets (UpdateEnvironmentRequestSecrets | Unset):
    """

    env: EnvVarsPatch | Unset = UNSET
    exclude_owner_secrets: bool | Unset = UNSET
    is_default: bool | Unset = UNSET
    name: str | Unset = UNSET
    repositories: list[RepositoryInput] | Unset = UNSET
    secret_files: SecretFilesPatch | Unset = UNSET
    secrets: UpdateEnvironmentRequestSecrets | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        exclude_owner_secrets = self.exclude_owner_secrets

        is_default = self.is_default

        name = self.name

        repositories: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.repositories, Unset):
            repositories = []
            for repositories_item_data in self.repositories:
                repositories_item = repositories_item_data.to_dict()
                repositories.append(repositories_item)

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
        if exclude_owner_secrets is not UNSET:
            field_dict["excludeOwnerSecrets"] = exclude_owner_secrets
        if is_default is not UNSET:
            field_dict["isDefault"] = is_default
        if name is not UNSET:
            field_dict["name"] = name
        if repositories is not UNSET:
            field_dict["repositories"] = repositories
        if secret_files is not UNSET:
            field_dict["secretFiles"] = secret_files
        if secrets is not UNSET:
            field_dict["secrets"] = secrets

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.env_vars_patch import EnvVarsPatch  # noqa: PLC0415
        from ..models.repository_input import RepositoryInput  # noqa: PLC0415
        from ..models.secret_files_patch import SecretFilesPatch  # noqa: PLC0415
        from ..models.update_environment_request_secrets import UpdateEnvironmentRequestSecrets  # noqa: PLC0415

        d = dict(src_dict)
        _env = d.pop("env", UNSET)
        env: EnvVarsPatch | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = EnvVarsPatch.from_dict(_env)

        exclude_owner_secrets = d.pop("excludeOwnerSecrets", UNSET)

        is_default = d.pop("isDefault", UNSET)

        name = d.pop("name", UNSET)

        _repositories = d.pop("repositories", UNSET)
        repositories: list[RepositoryInput] | Unset = UNSET
        if _repositories is not UNSET:
            repositories = []
            for repositories_item_data in _repositories:
                repositories_item = RepositoryInput.from_dict(repositories_item_data)

                repositories.append(repositories_item)

        _secret_files = d.pop("secretFiles", UNSET)
        secret_files: SecretFilesPatch | Unset
        if isinstance(_secret_files, Unset):
            secret_files = UNSET
        else:
            secret_files = SecretFilesPatch.from_dict(_secret_files)

        _secrets = d.pop("secrets", UNSET)
        secrets: UpdateEnvironmentRequestSecrets | Unset
        if isinstance(_secrets, Unset):
            secrets = UNSET
        else:
            secrets = UpdateEnvironmentRequestSecrets.from_dict(_secrets)

        update_environment_request = cls(
            env=env,
            exclude_owner_secrets=exclude_owner_secrets,
            is_default=is_default,
            name=name,
            repositories=repositories,
            secret_files=secret_files,
            secrets=secrets,
        )

        return update_environment_request
