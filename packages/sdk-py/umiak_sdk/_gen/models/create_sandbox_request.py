from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.create_sandbox_request_from import CreateSandboxRequestFrom
    from ..models.create_sandbox_request_secrets import CreateSandboxRequestSecrets
    from ..models.env_vars import EnvVars
    from ..models.labels import Labels
    from ..models.secret_file_input import SecretFileInput


T = TypeVar("T", bound="CreateSandboxRequest")


@_attrs_define
class CreateSandboxRequest:
    """
    Attributes:
        capacity_wait_seconds (int | Unset): Wait for capacity in the durable per-team FIFO queue, in seconds (default
            0: fail immediately)
        env (EnvVars | Unset): Variables `[A-Za-z_][A-Za-z0-9_]{0,127}`: up to 100, each value up to 32 KiB without NUL,
            256 KiB per set. `UMIAK_` is reserved except UMIAK_API_KEY, UMIAK_API_URL, UMIAK_TEAM, UMIAK_PROFILE. Values
            with a newline are not visible in SSH sessions.
        environment (None | str | Unset): Environment name or `env_...` (needs environments:read); absent: the team's
            default environment; null: none. Its sets are applied first, the request's sets on top Example: base.
        exclude_owner_secrets (bool | Unset): Do not pass the creator's personal secrets into the sandbox. Only false is
            accepted for now: true is 400 until sandboxes store the flag
        from_ (CreateSandboxRequestFrom | Unset): Create from a saved snapshot of the team (needs snapshots:read)
        idle_timeout_seconds (int | None | Unset): Stop after this many idle seconds (at least 60); null disables idle-
            stop
        labels (Labels | Unset): Free-form string labels: up to 64, keys up to 128 and values up to 256 characters
            Example: {'session': '42'}.
        name (None | str | Unset): Display name, up to 255 characters Example: ci-run-42.
        secret_files (list[SecretFileInput] | Unset):
        secrets (CreateSandboxRequestSecrets | Unset):
        size (str | Unset): Size slug; default: the template's default size Example: 2gb.
        slug (str | Unset): 3-40 characters `[a-z0-9]+(-[a-z0-9]+)*`, not ending in -<digits>; default: three random
            words Example: my-box.
        template (str | Unset): Template slug (GET /v1/templates); `windows-desktop` is a compatibility alias for
            `windows`; ignored with `from` Example: linux.
        ttl_seconds (int | None | Unset): Lifetime from ready in seconds; the deadline is ready + ttl; null: no TTL
    """

    capacity_wait_seconds: int | Unset = UNSET
    env: EnvVars | Unset = UNSET
    environment: None | str | Unset = UNSET
    exclude_owner_secrets: bool | Unset = UNSET
    from_: CreateSandboxRequestFrom | Unset = UNSET
    idle_timeout_seconds: int | None | Unset = UNSET
    labels: Labels | Unset = UNSET
    name: None | str | Unset = UNSET
    secret_files: list[SecretFileInput] | Unset = UNSET
    secrets: CreateSandboxRequestSecrets | Unset = UNSET
    size: str | Unset = UNSET
    slug: str | Unset = UNSET
    template: str | Unset = UNSET
    ttl_seconds: int | None | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        capacity_wait_seconds = self.capacity_wait_seconds

        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        environment: None | str | Unset
        if isinstance(self.environment, Unset):
            environment = UNSET
        else:
            environment = self.environment

        exclude_owner_secrets = self.exclude_owner_secrets

        from_: dict[str, Any] | Unset = UNSET
        if not isinstance(self.from_, Unset):
            from_ = self.from_.to_dict()

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

        secret_files: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.secret_files, Unset):
            secret_files = []
            for secret_files_item_data in self.secret_files:
                secret_files_item = secret_files_item_data.to_dict()
                secret_files.append(secret_files_item)

        secrets: dict[str, Any] | Unset = UNSET
        if not isinstance(self.secrets, Unset):
            secrets = self.secrets.to_dict()

        size = self.size

        slug = self.slug

        template = self.template

        ttl_seconds: int | None | Unset
        if isinstance(self.ttl_seconds, Unset):
            ttl_seconds = UNSET
        else:
            ttl_seconds = self.ttl_seconds

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if capacity_wait_seconds is not UNSET:
            field_dict["capacityWaitSeconds"] = capacity_wait_seconds
        if env is not UNSET:
            field_dict["env"] = env
        if environment is not UNSET:
            field_dict["environment"] = environment
        if exclude_owner_secrets is not UNSET:
            field_dict["excludeOwnerSecrets"] = exclude_owner_secrets
        if from_ is not UNSET:
            field_dict["from"] = from_
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
        if template is not UNSET:
            field_dict["template"] = template
        if ttl_seconds is not UNSET:
            field_dict["ttlSeconds"] = ttl_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_sandbox_request_from import CreateSandboxRequestFrom  # noqa: PLC0415
        from ..models.create_sandbox_request_secrets import CreateSandboxRequestSecrets  # noqa: PLC0415
        from ..models.env_vars import EnvVars  # noqa: PLC0415
        from ..models.labels import Labels  # noqa: PLC0415
        from ..models.secret_file_input import SecretFileInput  # noqa: PLC0415

        d = dict(src_dict)
        capacity_wait_seconds = d.pop("capacityWaitSeconds", UNSET)

        _env = d.pop("env", UNSET)
        env: EnvVars | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = EnvVars.from_dict(_env)

        def _parse_environment(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        environment = _parse_environment(d.pop("environment", UNSET))

        exclude_owner_secrets = d.pop("excludeOwnerSecrets", UNSET)

        _from_ = d.pop("from", UNSET)
        from_: CreateSandboxRequestFrom | Unset
        if isinstance(_from_, Unset):
            from_ = UNSET
        else:
            from_ = CreateSandboxRequestFrom.from_dict(_from_)

        def _parse_idle_timeout_seconds(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        idle_timeout_seconds = _parse_idle_timeout_seconds(d.pop("idleTimeoutSeconds", UNSET))

        _labels = d.pop("labels", UNSET)
        labels: Labels | Unset
        if isinstance(_labels, Unset):
            labels = UNSET
        else:
            labels = Labels.from_dict(_labels)

        def _parse_name(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        name = _parse_name(d.pop("name", UNSET))

        _secret_files = d.pop("secretFiles", UNSET)
        secret_files: list[SecretFileInput] | Unset = UNSET
        if _secret_files is not UNSET:
            secret_files = []
            for secret_files_item_data in _secret_files:
                secret_files_item = SecretFileInput.from_dict(secret_files_item_data)

                secret_files.append(secret_files_item)

        _secrets = d.pop("secrets", UNSET)
        secrets: CreateSandboxRequestSecrets | Unset
        if isinstance(_secrets, Unset):
            secrets = UNSET
        else:
            secrets = CreateSandboxRequestSecrets.from_dict(_secrets)

        size = d.pop("size", UNSET)

        slug = d.pop("slug", UNSET)

        template = d.pop("template", UNSET)

        def _parse_ttl_seconds(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        ttl_seconds = _parse_ttl_seconds(d.pop("ttlSeconds", UNSET))

        create_sandbox_request = cls(
            capacity_wait_seconds=capacity_wait_seconds,
            env=env,
            environment=environment,
            exclude_owner_secrets=exclude_owner_secrets,
            from_=from_,
            idle_timeout_seconds=idle_timeout_seconds,
            labels=labels,
            name=name,
            secret_files=secret_files,
            secrets=secrets,
            size=size,
            slug=slug,
            template=template,
            ttl_seconds=ttl_seconds,
        )

        return create_sandbox_request
