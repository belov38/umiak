from http import HTTPStatus
from typing import Any

import httpx

from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox_list import SandboxList
from ...models.sandboxes_list_all_teams import SandboxesListAllTeams
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    state: str | Unset = UNSET,
    label: list[str] | str | Unset = UNSET,
    template: str | Unset = UNSET,
    q: str | Unset = UNSET,
    all_teams: SandboxesListAllTeams | Unset = UNSET,
    team_id: str | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["state"] = state

    json_label: list[str] | str | Unset
    if isinstance(label, Unset):
        json_label = UNSET
    elif isinstance(label, list):
        json_label = label

    else:
        json_label = label
    params["label"] = json_label

    params["template"] = template

    params["q"] = q

    json_all_teams: str | Unset = UNSET
    if not isinstance(all_teams, Unset):
        json_all_teams = all_teams.value

    params["allTeams"] = json_all_teams

    params["teamId"] = team_id

    params["limit"] = limit

    params["cursor"] = cursor

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxList:
    if response.status_code == 200:
        response_200 = SandboxList.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    response_default = Error.from_dict(response.json())

    return response_default


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SandboxList]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    state: str | Unset = UNSET,
    label: list[str] | str | Unset = UNSET,
    template: str | Unset = UNSET,
    q: str | Unset = UNSET,
    all_teams: SandboxesListAllTeams | Unset = UNSET,
    team_id: str | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Response[Error | SandboxList]:
    """List sandboxes

     Sandboxes of the team, newest first, in pages of `limit` (default 50) with `nextCursor`. Filters:
    `state` (comma-separated; deleted ones only with state=deleted), `label=k=v` (repeat; all must
    match), `template`, `q` (prefix of name or slug). A platform operator in the dashboard may list
    every team with `allTeams=true` (and `teamId`).

    Args:
        state (str | Unset): Comma-separated states; default: all but deleted (deleted only when
            asked) Example: ready,stopped.
        label (list[str] | str | Unset): `key=value`; repeat for several (all must match) Example:
            session=42.
        template (str | Unset):
        q (str | Unset): Prefix of the name or slug, case-insensitive
        all_teams (SandboxesListAllTeams | Unset): `true`: sandboxes of every team. Only a
            platform operator in the dashboard (browser session); anyone else is 403 `forbidden`
            (details.reason `operator_required`)
        team_id (str | Unset): With allTeams=true: only this team (`team_...`) Example:
            team_01jbx2v7d3m6c8q9w0e4r5t6y7.
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxList]
    """

    kwargs = _get_kwargs(
        state=state,
        label=label,
        template=template,
        q=q,
        all_teams=all_teams,
        team_id=team_id,
        limit=limit,
        cursor=cursor,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    state: str | Unset = UNSET,
    label: list[str] | str | Unset = UNSET,
    template: str | Unset = UNSET,
    q: str | Unset = UNSET,
    all_teams: SandboxesListAllTeams | Unset = UNSET,
    team_id: str | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Error | SandboxList | None:
    """List sandboxes

     Sandboxes of the team, newest first, in pages of `limit` (default 50) with `nextCursor`. Filters:
    `state` (comma-separated; deleted ones only with state=deleted), `label=k=v` (repeat; all must
    match), `template`, `q` (prefix of name or slug). A platform operator in the dashboard may list
    every team with `allTeams=true` (and `teamId`).

    Args:
        state (str | Unset): Comma-separated states; default: all but deleted (deleted only when
            asked) Example: ready,stopped.
        label (list[str] | str | Unset): `key=value`; repeat for several (all must match) Example:
            session=42.
        template (str | Unset):
        q (str | Unset): Prefix of the name or slug, case-insensitive
        all_teams (SandboxesListAllTeams | Unset): `true`: sandboxes of every team. Only a
            platform operator in the dashboard (browser session); anyone else is 403 `forbidden`
            (details.reason `operator_required`)
        team_id (str | Unset): With allTeams=true: only this team (`team_...`) Example:
            team_01jbx2v7d3m6c8q9w0e4r5t6y7.
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxList
    """

    return sync_detailed(
        client=client,
        state=state,
        label=label,
        template=template,
        q=q,
        all_teams=all_teams,
        team_id=team_id,
        limit=limit,
        cursor=cursor,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    state: str | Unset = UNSET,
    label: list[str] | str | Unset = UNSET,
    template: str | Unset = UNSET,
    q: str | Unset = UNSET,
    all_teams: SandboxesListAllTeams | Unset = UNSET,
    team_id: str | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Response[Error | SandboxList]:
    """List sandboxes

     Sandboxes of the team, newest first, in pages of `limit` (default 50) with `nextCursor`. Filters:
    `state` (comma-separated; deleted ones only with state=deleted), `label=k=v` (repeat; all must
    match), `template`, `q` (prefix of name or slug). A platform operator in the dashboard may list
    every team with `allTeams=true` (and `teamId`).

    Args:
        state (str | Unset): Comma-separated states; default: all but deleted (deleted only when
            asked) Example: ready,stopped.
        label (list[str] | str | Unset): `key=value`; repeat for several (all must match) Example:
            session=42.
        template (str | Unset):
        q (str | Unset): Prefix of the name or slug, case-insensitive
        all_teams (SandboxesListAllTeams | Unset): `true`: sandboxes of every team. Only a
            platform operator in the dashboard (browser session); anyone else is 403 `forbidden`
            (details.reason `operator_required`)
        team_id (str | Unset): With allTeams=true: only this team (`team_...`) Example:
            team_01jbx2v7d3m6c8q9w0e4r5t6y7.
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxList]
    """

    kwargs = _get_kwargs(
        state=state,
        label=label,
        template=template,
        q=q,
        all_teams=all_teams,
        team_id=team_id,
        limit=limit,
        cursor=cursor,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    state: str | Unset = UNSET,
    label: list[str] | str | Unset = UNSET,
    template: str | Unset = UNSET,
    q: str | Unset = UNSET,
    all_teams: SandboxesListAllTeams | Unset = UNSET,
    team_id: str | Unset = UNSET,
    limit: int | Unset = UNSET,
    cursor: str | Unset = UNSET,
) -> Error | SandboxList | None:
    """List sandboxes

     Sandboxes of the team, newest first, in pages of `limit` (default 50) with `nextCursor`. Filters:
    `state` (comma-separated; deleted ones only with state=deleted), `label=k=v` (repeat; all must
    match), `template`, `q` (prefix of name or slug). A platform operator in the dashboard may list
    every team with `allTeams=true` (and `teamId`).

    Args:
        state (str | Unset): Comma-separated states; default: all but deleted (deleted only when
            asked) Example: ready,stopped.
        label (list[str] | str | Unset): `key=value`; repeat for several (all must match) Example:
            session=42.
        template (str | Unset):
        q (str | Unset): Prefix of the name or slug, case-insensitive
        all_teams (SandboxesListAllTeams | Unset): `true`: sandboxes of every team. Only a
            platform operator in the dashboard (browser session); anyone else is 403 `forbidden`
            (details.reason `operator_required`)
        team_id (str | Unset): With allTeams=true: only this team (`team_...`) Example:
            team_01jbx2v7d3m6c8q9w0e4r5t6y7.
        limit (int | Unset): Page size, 1-200 (default 50)
        cursor (str | Unset): `nextCursor` of the previous page, unchanged

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxList
    """

    return (
        await asyncio_detailed(
            client=client,
            state=state,
            label=label,
            template=template,
            q=q,
            all_teams=all_teams,
            team_id=team_id,
            limit=limit,
            cursor=cursor,
        )
    ).parsed
