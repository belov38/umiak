from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.env_vars_patch import EnvVarsPatch
    from ..models.fork_sandbox_request_labels import ForkSandboxRequestLabels
    from ..models.fork_sandbox_request_secrets import ForkSandboxRequestSecrets
    from ..models.secret_files_patch import SecretFilesPatch


T = TypeVar("T", bound="ForkSandboxRequest")


@_attrs_define
class ForkSandboxRequest:
    """Sets merge onto a copy of the source's sets; the source is not changed

    Attributes:
        env (EnvVarsPatch | Unset): Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without
            NUL, 256 KiB per set. `SBX_` is reserved except SBX_API_KEY, SBX_API_URL, SBX_TEAM, SBX_PROFILE. Values with a
            newline are not visible in SSH sessions. Merged by key: null deletes the key.
        idle_timeout_seconds (int | None | Unset): Stop after this many idle seconds (at least 60); null disables idle-
            stop
        labels (ForkSandboxRequestLabels | Unset):
        name (None | str | Unset): Display name, up to 255 characters Example: ci-run-42.
        secret_files (SecretFilesPatch | Unset): Secret files by name: a file replaces the one with that name, null
            deletes it
        secrets (ForkSandboxRequestSecrets | Unset):
        size (str | Unset): Default: the source's size
        slug (str | Unset): 3-40 characters `[a-z0-9]+(-[a-z0-9]+)*`, not ending in -<digits>; default: three random
            words Example: my-box.
        ttl_seconds (int | None | Unset): Lifetime from ready in seconds; the deadline is ready + ttl; null: no TTL
    """

    env: EnvVarsPatch | Unset = UNSET
    idle_timeout_seconds: int | None | Unset = UNSET
    labels: ForkSandboxRequestLabels | Unset = UNSET
    name: None | str | Unset = UNSET
    secret_files: SecretFilesPatch | Unset = UNSET
    secrets: ForkSandboxRequestSecrets | Unset = UNSET
    size: str | Unset = UNSET
    slug: str | Unset = UNSET
    ttl_seconds: int | None | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        idle_timeout_seconds: int | None | Unset
        if isinstance(self.idle_timeout_seconds, Unset):
            idle_timeout_seconds = UNSET
        else:
            idle_timeout_seconds = self.idle_timeout_seconds

        labels: dict[str, Any] | Unset = UNSET
        if not isinstance(self.labels, Unset):
            labels = self.labels.to_dict()

        name: None | str | Unset
        if isinstance(self.name, Unset):
            name = UNSET
        else:
            name = self.name

        secret_files: dict[str, Any] | Unset = UNSET
        if not isinstance(self.secret_files, Unset):
            secret_files = self.secret_files.to_dict()

        secrets: dict[str, Any] | Unset = UNSET
        if not isinstance(self.secrets, Unset):
            secrets = self.secrets.to_dict()

        size = self.size

        slug = self.slug

        ttl_seconds: int | None | Unset
        if isinstance(self.ttl_seconds, Unset):
            ttl_seconds = UNSET
        else:
            ttl_seconds = self.ttl_seconds

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if env is not UNSET:
            field_dict["env"] = env
        if idle_timeout_seconds is not UNSET:
            field_dict["idleTimeoutSeconds"] = idle_timeout_seconds
        if labels is not UNSET:
            field_dict["labels"] = labels
        if name is not UNSET:
            field_dict["name"] = name
        if secret_files is not UNSET:
            field_dict["secretFiles"] = secret_files
        if secrets is not UNSET:
            field_dict["secrets"] = secrets
        if size is not UNSET:
            field_dict["size"] = size
        if slug is not UNSET:
            field_dict["slug"] = slug
        if ttl_seconds is not UNSET:
            field_dict["ttlSeconds"] = ttl_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.env_vars_patch import EnvVarsPatch  # noqa: PLC0415
        from ..models.fork_sandbox_request_labels import ForkSandboxRequestLabels  # noqa: PLC0415
        from ..models.fork_sandbox_request_secrets import ForkSandboxRequestSecrets  # noqa: PLC0415
        from ..models.secret_files_patch import SecretFilesPatch  # noqa: PLC0415

        d = dict(src_dict)
        _env = d.pop("env", UNSET)
        env: EnvVarsPatch | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = EnvVarsPatch.from_dict(_env)

        def _parse_idle_timeout_seconds(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        idle_timeout_seconds = _parse_idle_timeout_seconds(d.pop("idleTimeoutSeconds", UNSET))

        _labels = d.pop("labels", UNSET)
        labels: ForkSandboxRequestLabels | Unset
        if isinstance(_labels, Unset):
            labels = UNSET
        else:
            labels = ForkSandboxRequestLabels.from_dict(_labels)

        def _parse_name(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        name = _parse_name(d.pop("name", UNSET))

        _secret_files = d.pop("secretFiles", UNSET)
        secret_files: SecretFilesPatch | Unset
        if isinstance(_secret_files, Unset):
            secret_files = UNSET
        else:
            secret_files = SecretFilesPatch.from_dict(_secret_files)

        _secrets = d.pop("secrets", UNSET)
        secrets: ForkSandboxRequestSecrets | Unset
        if isinstance(_secrets, Unset):
            secrets = UNSET
        else:
            secrets = ForkSandboxRequestSecrets.from_dict(_secrets)

        size = d.pop("size", UNSET)

        slug = d.pop("slug", UNSET)

        def _parse_ttl_seconds(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        ttl_seconds = _parse_ttl_seconds(d.pop("ttlSeconds", UNSET))

        fork_sandbox_request = cls(
            env=env,
            idle_timeout_seconds=idle_timeout_seconds,
            labels=labels,
            name=name,
            secret_files=secret_files,
            secrets=secrets,
            size=size,
            slug=slug,
            ttl_seconds=ttl_seconds,
        )

        return fork_sandbox_request
