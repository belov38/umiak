package update

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// createJunction creates an NTFS junction (mount point reparse point) at
// link that points at the absolute local directory target. link must not
// exist. The reparse data is a REPARSE_DATA_BUFFER with a
// MountPointReparseBuffer: the substitute name \??\<target> and the print
// name <target>, each NUL-terminated.
func createJunction(link, target string) (err error) {
	if !filepath.IsAbs(target) || len(target) < 3 || target[1] != ':' {
		return fmt.Errorf("update: junction target %q is not an absolute drive path", target)
	}
	target = filepath.Clean(target)
	buf, err := mountPointReparseData(`\??\`+target, target)
	if err != nil {
		return err
	}
	if err := os.Mkdir(link, 0o755); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(link)
		}
	}()
	p, err := windows.UTF16PtrFromString(link)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return fmt.Errorf("update: open %s: %w", link, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var n uint32
	if err := windows.DeviceIoControl(h, windows.FSCTL_SET_REPARSE_POINT, &buf[0], uint32(len(buf)), nil, 0, &n, nil); err != nil {
		return fmt.Errorf("update: set junction %s -> %s: %w", link, target, err)
	}
	return nil
}

// mountPointReparseData encodes a REPARSE_DATA_BUFFER of tag
// IO_REPARSE_TAG_MOUNT_POINT:
//
//	ReparseTag uint32, ReparseDataLength uint16, Reserved uint16,
//	SubstituteNameOffset, SubstituteNameLength,
//	PrintNameOffset, PrintNameLength uint16,
//	PathBuffer: substitute name, NUL, print name, NUL (UTF-16LE).
//
// Offsets and lengths are in bytes within PathBuffer; lengths exclude the
// NUL.
func mountPointReparseData(substitute, printName string) ([]byte, error) {
	sub := utf16.Encode([]rune(substitute))
	prn := utf16.Encode([]rune(printName))
	path := make([]uint16, 0, len(sub)+len(prn)+2)
	path = append(path, sub...)
	path = append(path, 0)
	path = append(path, prn...)
	path = append(path, 0)
	const header = 8      // tag, data length, reserved
	const mountHeader = 8 // four uint16 offsets and lengths
	dataLen := mountHeader + 2*len(path)
	if header+dataLen > windows.MAXIMUM_REPARSE_DATA_BUFFER_SIZE {
		return nil, errors.New("update: junction target is too long")
	}
	b := make([]byte, header+dataLen)
	le := binary.LittleEndian
	le.PutUint32(b[0:], windows.IO_REPARSE_TAG_MOUNT_POINT)
	le.PutUint16(b[4:], uint16(dataLen))
	le.PutUint16(b[8:], 0)
	le.PutUint16(b[10:], uint16(2*len(sub)))
	le.PutUint16(b[12:], uint16(2*(len(sub)+1)))
	le.PutUint16(b[14:], uint16(2*len(prn)))
	for i, c := range path {
		le.PutUint16(b[header+mountHeader+2*i:], c)
	}
	return b, nil
}
