from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.sandbox_activity import SandboxActivity
from ..models.sandbox_health import SandboxHealth
from ..models.sandbox_state import SandboxState
from ..models.sandbox_stop_reason_type_1 import SandboxStopReasonType1
from ..models.sandbox_stop_reason_type_2_type_1 import SandboxStopReasonType2Type1
from ..models.sandbox_stop_reason_type_3_type_1 import SandboxStopReasonType3Type1

if TYPE_CHECKING:
    from ..models.labels import Labels
    from ..models.operation import Operation
    from ..models.sandbox_endpoints import SandboxEndpoints
    from ..models.sandbox_environment_type_0 import SandboxEnvironmentType0
    from ..models.sandbox_error_type_0 import SandboxErrorType0
    from ..models.sandbox_origin import SandboxOrigin


T = TypeVar("T", bound="Sandbox")


@_attrs_define
class Sandbox:
    """A VM sandbox. Work with it while `state` is `ready`; deleted sandboxes stay readable for 30 days

    Attributes:
        active_operation (None | Operation): The running operation, or null
        activity (SandboxActivity):
        created_at (datetime.datetime): ISO 8601 UTC with milliseconds
        created_by (None | str): The person (`usr_...`); null when a team key created it
        created_by_key (None | str): The team key (`key_...`) that created it, else null
        deadline_at (datetime.datetime | None): When the TTL deletes the sandbox; null without a TTL
        degraded_since (datetime.datetime | None): ISO 8601 UTC with milliseconds
        deleted_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        endpoints (SandboxEndpoints):
        environment (None | SandboxEnvironmentType0): Environment the sandbox was created from (S8 §10)
        error (None | SandboxErrorType0): Why the sandbox is in `error` (create_failed, resume_failed, machine_lost,
            ...)
        exclude_owner_secrets (bool):
        health (SandboxHealth): degraded: the agent is not reachable; calls wait up to 30 s and give 503
            agent_unavailable
        health_reason (None | str):
        id (str):  Example: sb_01jbx4q3m7f8r2t6v9w0y1z2a3.
        idle_timeout_seconds (int | None):
        labels (Labels): Free-form string labels: up to 64, keys up to 128 and values up to 256 characters Example:
            {'session': '42'}.
        last_activity_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        memory_mb (int):
        name (None | str):
        origin (SandboxOrigin): What the sandbox was created from
        ready_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        size (str):  Example: 2gb.
        slug (str): Name in port URLs, SSH and the guest hostname Example: quiet-otter-lamp.
        state (SandboxState): `ready` means usable; creating, stopping, stopped, starting, error, deleting, deleted
        stop_reason (None | SandboxStopReasonType1 | SandboxStopReasonType2Type1 | SandboxStopReasonType3Type1): Why the
            sandbox stopped
        stopped_at (datetime.datetime | None): ISO 8601 UTC with milliseconds
        team_id (str):  Example: team_01jbx2v7d3m6c8q9w0e4r5t6y7.
        template (str):  Example: linux.
        template_version (None | str): Version of the template build the sandbox runs
        ttl_seconds (int | None):
        updated_at (datetime.datetime): ISO 8601 UTC with milliseconds
        vcpu (int):
    """

    active_operation: None | Operation
    activity: SandboxActivity
    created_at: datetime.datetime
    created_by: None | str
    created_by_key: None | str
    deadline_at: datetime.datetime | None
    degraded_since: datetime.datetime | None
    deleted_at: datetime.datetime | None
    endpoints: SandboxEndpoints
    environment: None | SandboxEnvironmentType0
    error: None | SandboxErrorType0
    exclude_owner_secrets: bool
    health: SandboxHealth
    health_reason: None | str
    id: str
    idle_timeout_seconds: int | None
    labels: Labels
    last_activity_at: datetime.datetime | None
    memory_mb: int
    name: None | str
    origin: SandboxOrigin
    ready_at: datetime.datetime | None
    size: str
    slug: str
    state: SandboxState
    stop_reason: (
        None | SandboxStopReasonType1 | SandboxStopReasonType2Type1 | SandboxStopReasonType3Type1
    )
    stopped_at: datetime.datetime | None
    team_id: str
    template: str
    template_version: None | str
    ttl_seconds: int | None
    updated_at: datetime.datetime
    vcpu: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.operation import Operation  # noqa: PLC0415
        from ..models.sandbox_environment_type_0 import SandboxEnvironmentType0  # noqa: PLC0415
        from ..models.sandbox_error_type_0 import SandboxErrorType0  # noqa: PLC0415

        active_operation: dict[str, Any] | None
        if isinstance(self.active_operation, Operation):
            active_operation = self.active_operation.to_dict()
        else:
            active_operation = self.active_operation

        activity = self.activity.value

        created_at = self.created_at.isoformat()

        created_by: None | str
        created_by = self.created_by

        created_by_key: None | str
        created_by_key = self.created_by_key

        deadline_at: None | str
        if isinstance(self.deadline_at, datetime.datetime):
            deadline_at = self.deadline_at.isoformat()
        else:
            deadline_at = self.deadline_at

        degraded_since: None | str
        if isinstance(self.degraded_since, datetime.datetime):
            degraded_since = self.degraded_since.isoformat()
        else:
            degraded_since = self.degraded_since

        deleted_at: None | str
        if isinstance(self.deleted_at, datetime.datetime):
            deleted_at = self.deleted_at.isoformat()
        else:
            deleted_at = self.deleted_at

        endpoints = self.endpoints.to_dict()

        environment: dict[str, Any] | None
        if isinstance(self.environment, SandboxEnvironmentType0):
            environment = self.environment.to_dict()
        else:
            environment = self.environment

        error: dict[str, Any] | None
        if isinstance(self.error, SandboxErrorType0):
            error = self.error.to_dict()
        else:
            error = self.error

        exclude_owner_secrets = self.exclude_owner_secrets

        health = self.health.value

        health_reason: None | str
        health_reason = self.health_reason

        id = self.id

        idle_timeout_seconds: int | None
        idle_timeout_seconds = self.idle_timeout_seconds

        labels = self.labels.to_dict()

        last_activity_at: None | str
        if isinstance(self.last_activity_at, datetime.datetime):
            last_activity_at = self.last_activity_at.isoformat()
        else:
            last_activity_at = self.last_activity_at

        memory_mb = self.memory_mb

        name: None | str
        name = self.name

        origin = self.origin.to_dict()

        ready_at: None | str
        if isinstance(self.ready_at, datetime.datetime):
            ready_at = self.ready_at.isoformat()
        else:
            ready_at = self.ready_at

        size = self.size

        slug = self.slug

        state = self.state.value

        stop_reason: None | str
        if isinstance(self.stop_reason, SandboxStopReasonType1):
            stop_reason = self.stop_reason.value
        elif isinstance(self.stop_reason, SandboxStopReasonType2Type1):
            stop_reason = self.stop_reason.value
        elif isinstance(self.stop_reason, SandboxStopReasonType3Type1):
            stop_reason = self.stop_reason.value
        else:
            stop_reason = self.stop_reason

        stopped_at: None | str
        if isinstance(self.stopped_at, datetime.datetime):
            stopped_at = self.stopped_at.isoformat()
        else:
            stopped_at = self.stopped_at

        team_id = self.team_id

        template = self.template

        template_version: None | str
        template_version = self.template_version

        ttl_seconds: int | None
        ttl_seconds = self.ttl_seconds

        updated_at = self.updated_at.isoformat()

        vcpu = self.vcpu

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "activeOperation": active_operation,
                "activity": activity,
                "createdAt": created_at,
                "createdBy": created_by,
                "createdByKey": created_by_key,
                "deadlineAt": deadline_at,
                "degradedSince": degraded_since,
                "deletedAt": deleted_at,
                "endpoints": endpoints,
                "environment": environment,
                "error": error,
                "excludeOwnerSecrets": exclude_owner_secrets,
                "health": health,
                "healthReason": health_reason,
                "id": id,
                "idleTimeoutSeconds": idle_timeout_seconds,
                "labels": labels,
                "lastActivityAt": last_activity_at,
                "memoryMb": memory_mb,
                "name": name,
                "origin": origin,
                "readyAt": ready_at,
                "size": size,
                "slug": slug,
                "state": state,
                "stopReason": stop_reason,
                "stoppedAt": stopped_at,
                "teamId": team_id,
                "template": template,
                "templateVersion": template_version,
                "ttlSeconds": ttl_seconds,
                "updatedAt": updated_at,
                "vcpu": vcpu,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.labels import Labels  # noqa: PLC0415
        from ..models.operation import Operation  # noqa: PLC0415
        from ..models.sandbox_endpoints import SandboxEndpoints  # noqa: PLC0415
        from ..models.sandbox_environment_type_0 import SandboxEnvironmentType0  # noqa: PLC0415
        from ..models.sandbox_error_type_0 import SandboxErrorType0  # noqa: PLC0415
        from ..models.sandbox_origin import SandboxOrigin  # noqa: PLC0415

        d = dict(src_dict)

        def _parse_active_operation(data: object) -> None | Operation:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                active_operation_type_0 = Operation.from_dict(data)

                return active_operation_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | Operation, data)

        active_operation = _parse_active_operation(d.pop("activeOperation"))

        activity = SandboxActivity(d.pop("activity"))

        created_at = datetime.datetime.fromisoformat(d.pop("createdAt"))

        def _parse_created_by(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        created_by = _parse_created_by(d.pop("createdBy"))

        def _parse_created_by_key(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        created_by_key = _parse_created_by_key(d.pop("createdByKey"))

        def _parse_deadline_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                deadline_at_type_0 = datetime.datetime.fromisoformat(data)

                return deadline_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        deadline_at = _parse_deadline_at(d.pop("deadlineAt"))

        def _parse_degraded_since(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                degraded_since_type_0 = datetime.datetime.fromisoformat(data)

                return degraded_since_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        degraded_since = _parse_degraded_since(d.pop("degradedSince"))

        def _parse_deleted_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                deleted_at_type_0 = datetime.datetime.fromisoformat(data)

                return deleted_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        deleted_at = _parse_deleted_at(d.pop("deletedAt"))

        endpoints = SandboxEndpoints.from_dict(d.pop("endpoints"))

        def _parse_environment(data: object) -> None | SandboxEnvironmentType0:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                environment_type_0 = SandboxEnvironmentType0.from_dict(data)

                return environment_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | SandboxEnvironmentType0, data)

        environment = _parse_environment(d.pop("environment"))

        def _parse_error(data: object) -> None | SandboxErrorType0:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                error_type_0 = SandboxErrorType0.from_dict(data)

                return error_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(None | SandboxErrorType0, data)

        error = _parse_error(d.pop("error"))

        exclude_owner_secrets = d.pop("excludeOwnerSecrets")

        health = SandboxHealth(d.pop("health"))

        def _parse_health_reason(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        health_reason = _parse_health_reason(d.pop("healthReason"))

        id = d.pop("id")

        def _parse_idle_timeout_seconds(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        idle_timeout_seconds = _parse_idle_timeout_seconds(d.pop("idleTimeoutSeconds"))

        labels = Labels.from_dict(d.pop("labels"))

        def _parse_last_activity_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                last_activity_at_type_0 = datetime.datetime.fromisoformat(data)

                return last_activity_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        last_activity_at = _parse_last_activity_at(d.pop("lastActivityAt"))

        memory_mb = d.pop("memoryMb")

        def _parse_name(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        name = _parse_name(d.pop("name"))

        origin = SandboxOrigin.from_dict(d.pop("origin"))

        def _parse_ready_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                ready_at_type_0 = datetime.datetime.fromisoformat(data)

                return ready_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        ready_at = _parse_ready_at(d.pop("readyAt"))

        size = d.pop("size")

        slug = d.pop("slug")

        state = SandboxState(d.pop("state"))

        def _parse_stop_reason(
            data: object,
        ) -> (
            None
            | SandboxStopReasonType1
            | SandboxStopReasonType2Type1
            | SandboxStopReasonType3Type1
        ):
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                stop_reason_type_1 = SandboxStopReasonType1(data)

                return stop_reason_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                stop_reason_type_2_type_1 = SandboxStopReasonType2Type1(data)

                return stop_reason_type_2_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            try:
                if not isinstance(data, str):
                    raise TypeError()
                stop_reason_type_3_type_1 = SandboxStopReasonType3Type1(data)

                return stop_reason_type_3_type_1
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(
                None
                | SandboxStopReasonType1
                | SandboxStopReasonType2Type1
                | SandboxStopReasonType3Type1,
                data,
            )

        stop_reason = _parse_stop_reason(d.pop("stopReason"))

        def _parse_stopped_at(data: object) -> datetime.datetime | None:
            if data is None:
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                stopped_at_type_0 = datetime.datetime.fromisoformat(data)

                return stopped_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None, data)

        stopped_at = _parse_stopped_at(d.pop("stoppedAt"))

        team_id = d.pop("teamId")

        template = d.pop("template")

        def _parse_template_version(data: object) -> None | str:
            if data is None:
                return data
            return cast(None | str, data)

        template_version = _parse_template_version(d.pop("templateVersion"))

        def _parse_ttl_seconds(data: object) -> int | None:
            if data is None:
                return data
            return cast(int | None, data)

        ttl_seconds = _parse_ttl_seconds(d.pop("ttlSeconds"))

        updated_at = datetime.datetime.fromisoformat(d.pop("updatedAt"))

        vcpu = d.pop("vcpu")

        sandbox = cls(
            active_operation=active_operation,
            activity=activity,
            created_at=created_at,
            created_by=created_by,
            created_by_key=created_by_key,
            deadline_at=deadline_at,
            degraded_since=degraded_since,
            deleted_at=deleted_at,
            endpoints=endpoints,
            environment=environment,
            error=error,
            exclude_owner_secrets=exclude_owner_secrets,
            health=health,
            health_reason=health_reason,
            id=id,
            idle_timeout_seconds=idle_timeout_seconds,
            labels=labels,
            last_activity_at=last_activity_at,
            memory_mb=memory_mb,
            name=name,
            origin=origin,
            ready_at=ready_at,
            size=size,
            slug=slug,
            state=state,
            stop_reason=stop_reason,
            stopped_at=stopped_at,
            team_id=team_id,
            template=template,
            template_version=template_version,
            ttl_seconds=ttl_seconds,
            updated_at=updated_at,
            vcpu=vcpu,
        )

        sandbox.additional_properties = d
        return sandbox

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
