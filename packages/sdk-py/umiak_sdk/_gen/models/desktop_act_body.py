from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.desktop_act_body_actions_item_type_0 import DesktopActBodyActionsItemType0
    from ..models.desktop_act_body_actions_item_type_1 import DesktopActBodyActionsItemType1
    from ..models.desktop_act_body_actions_item_type_2 import DesktopActBodyActionsItemType2
    from ..models.desktop_act_body_actions_item_type_3 import DesktopActBodyActionsItemType3
    from ..models.desktop_act_body_actions_item_type_4 import DesktopActBodyActionsItemType4
    from ..models.desktop_act_body_actions_item_type_5 import DesktopActBodyActionsItemType5
    from ..models.desktop_act_body_actions_item_type_6 import DesktopActBodyActionsItemType6
    from ..models.desktop_act_body_actions_item_type_7 import DesktopActBodyActionsItemType7
    from ..models.desktop_act_body_actions_item_type_8 import DesktopActBodyActionsItemType8
    from ..models.desktop_act_body_coordinate_space import DesktopActBodyCoordinateSpace
    from ..models.desktop_act_body_screenshot import DesktopActBodyScreenshot


T = TypeVar("T", bound="DesktopActBody")


@_attrs_define
class DesktopActBody:
    """
    Attributes:
        actions (list[DesktopActBodyActionsItemType0 | DesktopActBodyActionsItemType1 | DesktopActBodyActionsItemType2 |
            DesktopActBodyActionsItemType3 | DesktopActBodyActionsItemType4 | DesktopActBodyActionsItemType5 |
            DesktopActBodyActionsItemType6 | DesktopActBodyActionsItemType7 | DesktopActBodyActionsItemType8]):
        coordinate_space (DesktopActBodyCoordinateSpace | Unset):
        screenshot (DesktopActBodyScreenshot | Unset):
    """

    actions: list[
        DesktopActBodyActionsItemType0
        | DesktopActBodyActionsItemType1
        | DesktopActBodyActionsItemType2
        | DesktopActBodyActionsItemType3
        | DesktopActBodyActionsItemType4
        | DesktopActBodyActionsItemType5
        | DesktopActBodyActionsItemType6
        | DesktopActBodyActionsItemType7
        | DesktopActBodyActionsItemType8
    ]
    coordinate_space: DesktopActBodyCoordinateSpace | Unset = UNSET
    screenshot: DesktopActBodyScreenshot | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        from ..models.desktop_act_body_actions_item_type_0 import DesktopActBodyActionsItemType0  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_1 import DesktopActBodyActionsItemType1  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_2 import DesktopActBodyActionsItemType2  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_3 import DesktopActBodyActionsItemType3  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_4 import DesktopActBodyActionsItemType4  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_5 import DesktopActBodyActionsItemType5  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_6 import DesktopActBodyActionsItemType6  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_7 import DesktopActBodyActionsItemType7  # noqa: PLC0415

        actions = []
        for actions_item_data in self.actions:
            actions_item: dict[str, Any]
            if isinstance(actions_item_data, DesktopActBodyActionsItemType0):
                actions_item = actions_item_data.to_dict()
            elif isinstance(actions_item_data, DesktopActBodyActionsItemType1):
                actions_item = actions_item_data.to_dict()
            elif isinstance(actions_item_data, DesktopActBodyActionsItemType2):
                actions_item = actions_item_data.to_dict()
            elif isinstance(actions_item_data, DesktopActBodyActionsItemType3):
                actions_item = actions_item_data.to_dict()
            elif isinstance(actions_item_data, DesktopActBodyActionsItemType4):
                actions_item = actions_item_data.to_dict()
            elif isinstance(actions_item_data, DesktopActBodyActionsItemType5):
                actions_item = actions_item_data.to_dict()
            elif isinstance(actions_item_data, DesktopActBodyActionsItemType6):
                actions_item = actions_item_data.to_dict()
            elif isinstance(actions_item_data, DesktopActBodyActionsItemType7):
                actions_item = actions_item_data.to_dict()
            else:
                actions_item = actions_item_data.to_dict()

            actions.append(actions_item)

        coordinate_space: dict[str, Any] | Unset = UNSET
        if not isinstance(self.coordinate_space, Unset):
            coordinate_space = self.coordinate_space.to_dict()

        screenshot: dict[str, Any] | Unset = UNSET
        if not isinstance(self.screenshot, Unset):
            screenshot = self.screenshot.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "actions": actions,
            }
        )
        if coordinate_space is not UNSET:
            field_dict["coordinateSpace"] = coordinate_space
        if screenshot is not UNSET:
            field_dict["screenshot"] = screenshot

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.desktop_act_body_actions_item_type_0 import DesktopActBodyActionsItemType0  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_1 import DesktopActBodyActionsItemType1  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_2 import DesktopActBodyActionsItemType2  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_3 import DesktopActBodyActionsItemType3  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_4 import DesktopActBodyActionsItemType4  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_5 import DesktopActBodyActionsItemType5  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_6 import DesktopActBodyActionsItemType6  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_7 import DesktopActBodyActionsItemType7  # noqa: PLC0415
        from ..models.desktop_act_body_actions_item_type_8 import DesktopActBodyActionsItemType8  # noqa: PLC0415
        from ..models.desktop_act_body_coordinate_space import DesktopActBodyCoordinateSpace  # noqa: PLC0415
        from ..models.desktop_act_body_screenshot import DesktopActBodyScreenshot  # noqa: PLC0415

        d = dict(src_dict)
        actions = []
        _actions = d.pop("actions")
        for actions_item_data in _actions:

            def _parse_actions_item(
                data: object,
            ) -> (
                DesktopActBodyActionsItemType0
                | DesktopActBodyActionsItemType1
                | DesktopActBodyActionsItemType2
                | DesktopActBodyActionsItemType3
                | DesktopActBodyActionsItemType4
                | DesktopActBodyActionsItemType5
                | DesktopActBodyActionsItemType6
                | DesktopActBodyActionsItemType7
                | DesktopActBodyActionsItemType8
            ):
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_0 = DesktopActBodyActionsItemType0.from_dict(data)

                    return actions_item_type_0
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_1 = DesktopActBodyActionsItemType1.from_dict(data)

                    return actions_item_type_1
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_2 = DesktopActBodyActionsItemType2.from_dict(data)

                    return actions_item_type_2
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_3 = DesktopActBodyActionsItemType3.from_dict(data)

                    return actions_item_type_3
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_4 = DesktopActBodyActionsItemType4.from_dict(data)

                    return actions_item_type_4
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_5 = DesktopActBodyActionsItemType5.from_dict(data)

                    return actions_item_type_5
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_6 = DesktopActBodyActionsItemType6.from_dict(data)

                    return actions_item_type_6
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                try:
                    if not isinstance(data, dict):
                        raise TypeError()
                    actions_item_type_7 = DesktopActBodyActionsItemType7.from_dict(data)

                    return actions_item_type_7
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass
                if not isinstance(data, dict):
                    raise TypeError()
                actions_item_type_8 = DesktopActBodyActionsItemType8.from_dict(data)

                return actions_item_type_8

            actions_item = _parse_actions_item(actions_item_data)

            actions.append(actions_item)

        _coordinate_space = d.pop("coordinateSpace", UNSET)
        coordinate_space: DesktopActBodyCoordinateSpace | Unset
        if isinstance(_coordinate_space, Unset):
            coordinate_space = UNSET
        else:
            coordinate_space = DesktopActBodyCoordinateSpace.from_dict(_coordinate_space)

        _screenshot = d.pop("screenshot", UNSET)
        screenshot: DesktopActBodyScreenshot | Unset
        if isinstance(_screenshot, Unset):
            screenshot = UNSET
        else:
            screenshot = DesktopActBodyScreenshot.from_dict(_screenshot)

        desktop_act_body = cls(
            actions=actions,
            coordinate_space=coordinate_space,
            screenshot=screenshot,
        )

        desktop_act_body.additional_properties = d
        return desktop_act_body

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
