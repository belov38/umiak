from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.create_pty_request_env import CreatePtyRequestEnv


T = TypeVar("T", bound="CreatePtyRequest")


@_attrs_define
class CreatePtyRequest:
    """
    Attributes:
        cols (int | Unset): Columns, 1 to 1000 (default 80) Example: 120.
        command (None | str | Unset): Shell command line run by `bash -lc` in the terminal; null or absent: the user's
            login shell
        cwd (None | str | Unset): Working directory; relative to the user's home (default)
        env (CreatePtyRequestEnv | Unset):
        rows (int | Unset): Rows, 1 to 1000 (default 24) Example: 32.
        term (str | Unset): TERM of the terminal (default xterm-256color) Example: xterm-256color.
        user (str | Unset): Guest user (default `user`; `root` is allowed)
    """

    cols: int | Unset = UNSET
    command: None | str | Unset = UNSET
    cwd: None | str | Unset = UNSET
    env: CreatePtyRequestEnv | Unset = UNSET
    rows: int | Unset = UNSET
    term: str | Unset = UNSET
    user: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        cols = self.cols

        command: None | str | Unset
        if isinstance(self.command, Unset):
            command = UNSET
        else:
            command = self.command

        cwd: None | str | Unset
        if isinstance(self.cwd, Unset):
            cwd = UNSET
        else:
            cwd = self.cwd

        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        rows = self.rows

        term = self.term

        user = self.user

        field_dict: dict[str, Any] = {}

        field_dict.update({})
        if cols is not UNSET:
            field_dict["cols"] = cols
        if command is not UNSET:
            field_dict["command"] = command
        if cwd is not UNSET:
            field_dict["cwd"] = cwd
        if env is not UNSET:
            field_dict["env"] = env
        if rows is not UNSET:
            field_dict["rows"] = rows
        if term is not UNSET:
            field_dict["term"] = term
        if user is not UNSET:
            field_dict["user"] = user

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_pty_request_env import CreatePtyRequestEnv  # noqa: PLC0415

        d = dict(src_dict)
        cols = d.pop("cols", UNSET)

        def _parse_command(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        command = _parse_command(d.pop("command", UNSET))

        def _parse_cwd(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        cwd = _parse_cwd(d.pop("cwd", UNSET))

        _env = d.pop("env", UNSET)
        env: CreatePtyRequestEnv | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = CreatePtyRequestEnv.from_dict(_env)

        rows = d.pop("rows", UNSET)

        term = d.pop("term", UNSET)

        user = d.pop("user", UNSET)

        create_pty_request = cls(
            cols=cols,
            command=command,
            cwd=cwd,
            env=env,
            rows=rows,
            term=term,
            user=user,
        )

        return create_pty_request
