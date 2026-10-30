package winapi

import (
	"errors"
	"fmt"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

// LogonUserW logon type and provider (winbase.h).
const (
	logon32LogonInteractive = 2
	logon32ProviderDefault  = 0
)

// TOKEN_ELEVATION_TYPE values.
const tokenElevationTypeLimited = 3

var procLogonUserW = modadvapi32.NewProc("LogonUserW")

// LogonUserToken logs the local account user on interactively with the
// UTF-8 password and returns its elevated token: the linked full token when
// UAC split the logon into a limited and a full one (spec 12.5). The token
// carries the password, so DPAPI and Credential Manager work in the
// processes that use it. The password is taken as bytes so the caller can
// wipe it; the UTF-16 copy made here is wiped too. The caller closes the
// token.
func LogonUserToken(user string, password []byte) (windows.Token, error) {
	u, err := windows.UTF16PtrFromString(user)
	if err != nil {
		return 0, fmt.Errorf("winapi: logon %s: %w", user, err)
	}
	dot, _ := windows.UTF16PtrFromString(".")
	pw, err := utf16Secret(password)
	if err != nil {
		return 0, fmt.Errorf("winapi: logon %s: password: %w", user, err)
	}
	defer clear(pw)
	var t windows.Token
	r, _, e := procLogonUserW.Call(
		uintptr(unsafe.Pointer(u)), uintptr(unsafe.Pointer(dot)), uintptr(unsafe.Pointer(&pw[0])),
		logon32LogonInteractive, logon32ProviderDefault, uintptr(unsafe.Pointer(&t)))
	if r == 0 {
		return 0, fmt.Errorf("winapi: LogonUserW %s: %w", user, callErr(e))
	}
	var typ, n uint32
	if err := windows.GetTokenInformation(t, windows.TokenElevationType,
		(*byte)(unsafe.Pointer(&typ)), uint32(unsafe.Sizeof(typ)), &n); err != nil {
		_ = t.Close()
		return 0, fmt.Errorf("winapi: logon %s: elevation type: %w", user, err)
	}
	if typ != tokenElevationTypeLimited {
		return t, nil
	}
	// With SeTcbPrivilege (SYSTEM) the linked token is a primary token
	// usable by CreateProcessAsUser.
	full, err := t.GetLinkedToken()
	_ = t.Close()
	if err != nil {
		return 0, fmt.Errorf("winapi: logon %s: linked token: %w", user, err)
	}
	return full, nil
}

// utf16Secret converts the UTF-8 secret b to a NUL-terminated UTF-16 buffer
// without an intermediate string. The buffer never grows (a UTF-8 sequence
// is at least as long as its UTF-16 form), so no unwiped copy is left
// behind; the caller clears it.
func utf16Secret(b []byte) ([]uint16, error) {
	out := make([]uint16, 0, len(b)+1)
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == 0 {
			clear(out)
			return nil, errors.New("contains NUL")
		}
		out = utf16.AppendRune(out, r)
		b = b[n:]
	}
	return append(out, 0), nil
}
