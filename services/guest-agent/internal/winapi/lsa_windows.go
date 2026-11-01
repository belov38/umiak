package winapi

import (
	"errors"
	"fmt"
	"math"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SecretUserPassword is the LSA secret with the password of the account
// `user` (spec 11.2, 12.5). The L$ prefix makes it a local secret.
const SecretUserPassword = "L$umiak_user"

// LSA policy access rights (ntsecapi.h).
const (
	policyGetPrivateInformation = 0x00000004
	policyCreateSecret          = 0x00000020
)

var (
	procLsaOpenPolicy          = modadvapi32.NewProc("LsaOpenPolicy")
	procLsaClose               = modadvapi32.NewProc("LsaClose")
	procLsaFreeMemory          = modadvapi32.NewProc("LsaFreeMemory")
	procLsaStorePrivateData    = modadvapi32.NewProc("LsaStorePrivateData")
	procLsaRetrievePrivateData = modadvapi32.NewProc("LsaRetrievePrivateData")
)

// LsaRetrieve returns the LSA private data name. A missing secret is an
// error that matches os.ErrNotExist.
func LsaRetrieve(name string) ([]byte, error) {
	key, err := lsaString(name)
	if err != nil {
		return nil, err
	}
	pol, err := lsaOpenPolicy(policyGetPrivateInformation)
	if err != nil {
		return nil, err
	}
	defer lsaClose(pol)
	var data *windows.NTUnicodeString
	r, _, _ := procLsaRetrievePrivateData.Call(pol, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&data)))
	if st := windows.NTStatus(r); st != windows.STATUS_SUCCESS {
		return nil, fmt.Errorf("winapi: LsaRetrievePrivateData %s: %w", name, st.Errno())
	}
	if data == nil {
		return []byte{}, nil
	}
	defer procLsaFreeMemory.Call(uintptr(unsafe.Pointer(data))) //nolint:errcheck // nothing to do on failure
	if data.Buffer == nil || data.Length == 0 {
		return []byte{}, nil
	}
	raw := unsafe.Slice((*byte)(unsafe.Pointer(data.Buffer)), data.Length)
	out := make([]byte, len(raw))
	copy(out, raw)
	clear(raw)
	return out, nil
}

// LsaStore stores data as the LSA private data name; empty data deletes the
// secret (deleting a missing one is not an error).
func LsaStore(name string, data []byte) error {
	if len(data) > math.MaxUint16 {
		return fmt.Errorf("winapi: LSA secret %s: %d bytes is too large", name, len(data))
	}
	key, err := lsaString(name)
	if err != nil {
		return err
	}
	pol, err := lsaOpenPolicy(policyCreateSecret | policyGetPrivateInformation)
	if err != nil {
		return err
	}
	defer lsaClose(pol)
	var val *windows.NTUnicodeString
	if len(data) > 0 {
		// Buffer is a PWSTR: give it a WCHAR-aligned copy, wiped after.
		buf := make([]uint16, (len(data)+1)/2)
		defer clear(buf)
		copy(unsafe.Slice((*byte)(unsafe.Pointer(&buf[0])), 2*len(buf)), data)
		n := uint16(len(data)) //nolint:gosec // checked above
		val = &windows.NTUnicodeString{Length: n, MaximumLength: n, Buffer: &buf[0]}
	}
	r, _, _ := procLsaStorePrivateData.Call(pol, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(val)))
	st := windows.NTStatus(r)
	if st == windows.STATUS_OBJECT_NAME_NOT_FOUND && val == nil {
		return nil
	}
	if st != windows.STATUS_SUCCESS {
		return fmt.Errorf("winapi: LsaStorePrivateData %s: %w", name, st.Errno())
	}
	return nil
}

// lsaOpenPolicy opens the local LSA policy with access.
func lsaOpenPolicy(access uint32) (uintptr, error) {
	// LSA_OBJECT_ATTRIBUTES has the layout of OBJECT_ATTRIBUTES; LSA
	// ignores its fields but Length.
	var attrs windows.OBJECT_ATTRIBUTES
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var h uintptr
	r, _, _ := procLsaOpenPolicy.Call(0, uintptr(unsafe.Pointer(&attrs)), uintptr(access), uintptr(unsafe.Pointer(&h)))
	if st := windows.NTStatus(r); st != windows.STATUS_SUCCESS {
		return 0, fmt.Errorf("winapi: LsaOpenPolicy: %w", st.Errno())
	}
	return h, nil
}

func lsaClose(h uintptr) {
	_, _, _ = procLsaClose.Call(h)
}

// lsaString returns s as an LSA_UNICODE_STRING (lengths in bytes, without
// the terminator).
func lsaString(s string) (*windows.NTUnicodeString, error) {
	u, err := windows.UTF16FromString(s)
	if err != nil {
		return nil, fmt.Errorf("winapi: LSA name %q: %w", s, err)
	}
	n := 2 * (len(u) - 1)
	if n == 0 || n > math.MaxUint16-2 {
		return nil, errors.New("winapi: LSA name must be 1..32766 characters")
	}
	return &windows.NTUnicodeString{
		Length:        uint16(n),     //nolint:gosec // checked above
		MaximumLength: uint16(n + 2), //nolint:gosec // checked above
		Buffer:        &u[0],
	}, nil
}
