from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define

from ..types import UNSET, Unset

T = TypeVar("T", bound="RepositoryInput")


@_attrs_define
class RepositoryInput:
    """
    Attributes:
        url (str): https://..., ssh://... or git@host:org/repo.git, without credentials, a query or a fragment Example:
            https://github.com/acme/web.git.
        branch (str | Unset): Branch or tag
        path (str | Unset): Directory relative to the home of `user` (default: the repository name)
    """

    url: str
    branch: str | Unset = UNSET
    path: str | Unset = UNSET

    def to_dict(self) -> dict[str, Any]:
        url = self.url

        branch = self.branch

        path = self.path

        field_dict: dict[str, Any] = {}

        field_dict.update(
            {
                "url": url,
            }
        )
        if branch is not UNSET:
            field_dict["branch"] = branch
        if path is not UNSET:
            field_dict["path"] = path

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        url = d.pop("url")

        branch = d.pop("branch", UNSET)

        path = d.pop("path", UNSET)

        repository_input = cls(
            url=url,
            branch=branch,
            path=path,
        )

        return repository_input
