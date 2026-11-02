from enum import StrEnum


class LimitsTemplatesItemSizesItemReasonType2Type1(StrEnum):
    QUOTA_ACTIVE_SANDBOXES = "quota_active_sandboxes"
    QUOTA_RAM = "quota_ram"
    TEMPLATE_DISABLED = "template_disabled"

    def __str__(self) -> str:
        return str(self.value)

    @classmethod
    def _missing_(cls, value: object) -> "LimitsTemplatesItemSizesItemReasonType2Type1 | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
