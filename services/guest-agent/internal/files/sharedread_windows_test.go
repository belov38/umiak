package files

import (
	"errors"
	"io"
	"os"

	"golang.org/x/sys/windows"
)

// readShared reads path through a handle that shares read, write and delete,
// like the readers the atomic replace is meant for: os.ReadFile does not
// share delete, and a replace while it holds the file is file_in_use (S9
// spec 12.9). A sharing violation of the open (the replace holds the file
// for a moment) is reported as errBusy.
func readShared(path string) ([]byte, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		return nil, errBusy
	}
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(h), path)
	defer func() { _ = f.Close() }()
	return io.ReadAll(f)
}
