from enum import StrEnum


class FilesUploadArchiveFormat(StrEnum):
    TAR = "tar"
    TAR_GZ = "tar.gz"

    def __str__(self) -> str:
        return str(self.value)
