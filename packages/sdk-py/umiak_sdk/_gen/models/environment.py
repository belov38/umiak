from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.environment_env import EnvironmentEnv
    from ..models.environment_repositories_item import EnvironmentRepositoriesItem
    from ..models.environment_secret_files_item import EnvironmentSecretFilesItem


T = TypeVar("T", bound="Environment")


@_attrs_define
class Environment:
    """An environment with its env values (secret values never)

    Attributes:
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        env (EnvironmentEnv):
        env_keys (list[str]): Names of env variables
        exclude_owner_secrets (bool):
        id (str):  Example: env_01jbx2v7d3m6c8q9w0e4r5t6y7.
        is_default (bool):
        name (str):  Example: production.
        repositories (list[EnvironmentRepositoriesItem]):
        revision (int): 1 on create, + 1 on every change
        secret_files (list[EnvironmentSecretFilesItem]):
        secret_keys (list[str]): Names of secret variables (values never)
        updated_at (datetime.datetime): ISO 8601 UTC with milliseconds
        updated_by (None | str): User (`usr_...`) of the last change; null for a team key
    """

    created_at: datetime.datetime
    env: EnvironmentEnv
    env_keys: list[str]
    exclude_owner_secrets: bool
    id: str
    is_default: bool
    name: str
    repositories: list[EnvironmentRepositoriesItem]
    revision: int
    secret_files: list[EnvironmentSecretFilesItem]
    secret_keys: list[str]
    updated_at: datetime.datetime
    updated_by: None | str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        created_at = self.created_at.isoformat()

        env = self.env.to_dict()

        env_keys = self.env_keys

        exclude_owner_secrets = self.exclude_owner_secrets

        id = self.id

        is_default = self.is_default

        name = self.name

        repositories = []
        for repositories_item_data in self.repositories:
            repositories_item = repositories_item_data.to_dict()
            repositories.append(repositories_item)

        revision = self.revision

        secret_files = []
        for secret_files_item_data in self.secret_files:
            secret_files_item = secret_files_item_data.to_dict()
            secret_files.append(secret_files_item)

        secret_keys = self.secret_keys

        updated_at = self.updated_at.isoformat()

        updated_by: None | str
        updated_by = self.updated_by

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "createdAt": created_at,
                "env": env,
                "envKeys": env_keys,
                "excludeOwnerSecrets": exclude_owner_secrets,
                "id": id,
                "isDefault": is_default,
                "name": name,
                "repositories": repositories,
                "revision": revision,
                "secretFiles": secret_files,
                "secretKeys": secret_keys,
                "updatedAt": updated_at,
                "updatedBy": updated_by,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.environment_env import EnvironmentEnv  # noqa: PLC0415
        from ..models.environment_repositories_item import EnvironmentRepositoriesItem  # noqa: PLC0415
        from ..models.environment_secret_files_item import EnvironmentSecretFilesItem  # noqa: PLC0415

        d = dict(src_dict)
        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        env = EnvironmentEnv.from_dict(d.pop("env"))

        env_keys = cast(list[str], d.pop("envKeys"))

        exclude_owner_secrets = d.pop("excludeOwnerSecrets")

        id = d.pop("id")

        is_default = d.pop("isDefault")

        name = d.pop("name")

        repositories = []
        _repositories = d.pop("repositories")
        for repositories_item_data in _repositories:
            repositories_item = EnvironmentRepositoriesItem.from_dict(repositories_item_data)

            repositories.append(repositories_item)

        revision = d.pop("revision")

        secret_files = []
        _secret_files = d.pop("secretFiles")
        for secret_files_item_data in _secret_files:
            secret_files_item = EnvironmentSecretFilesItem.from_dict(secret_files_item_data)

            secret_files.append(secret_files_item)

        secret_keys = cast(list[str], d.pop("secretKeys"))

        updated_at = datetime.datetime.fromisoformat(d.pop("updatedAt"))

        def _parse_updated_by(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        updated_by = _parse_updated_by(d.pop("updatedBy"))

        environment = cls(
            created_at=created_at,
            env=env,
            env_keys=env_keys,
            exclude_owner_secrets=exclude_owner_secrets,
            id=id,
            is_default=is_default,
            name=name,
            repositories=repositories,
            revision=revision,
            secret_files=secret_files,
            secret_keys=secret_keys,
            updated_at=updated_at,
            updated_by=updated_by,
        )

        environment.additional_properties = d
        return environment

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
