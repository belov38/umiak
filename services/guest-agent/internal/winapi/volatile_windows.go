package winapi

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	"github.com/google/uuid"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var procRegCreateKeyExW = modadvapi32.NewProc("RegCreateKeyExW")

const (
	// volatileParent is a normal key; volatileName under it is created
	// with REG_OPTION_VOLATILE, so the hive keeps it in memory only and it
	// is gone after a reboot (a wake from sleep keeps it).
	volatileParent = `SOFTWARE\sbx-agent`
	volatileName   = "Volatile"
	bootIDValue    = "BootId"
	// volatileSDDL keeps the key to SYSTEM.
	volatileSDDL = "D:P(A;CI;KA;;;SY)"

	regOptionVolatile = 1
	regCreatedNewKey  = 1

	// bootIDWait bounds the wait for a value another process is about to
	// write into a key it just created.
	bootIDWait = time.Second
)

// VolatileBootID returns a random id that lives as long as this boot: the
// first caller of a boot creates HKLM\SOFTWARE\sbx-agent\Volatile
// (volatile, SYSTEM only) and stores a new UUID in it, later callers read
// it. Unlike the kernel boot time it does not move with the system clock,
// and unlike a file it cannot outlive the boot (S9 spec 12.4 fallback).
func VolatileBootID() (string, error) {
	parent, _, err := registry.CreateKey(registry.LOCAL_MACHINE, volatileParent, registry.CREATE_SUB_KEY|registry.WOW64_64KEY)
	if err != nil {
		return "", fmt.Errorf("winapi: create %s: %w", volatileParent, err)
	}
	defer parent.Close() //nolint:errcheck // nothing written through it
	sd, err := windows.SecurityDescriptorFromString(volatileSDDL)
	if err != nil {
		return "", err
	}
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	name, err := windows.UTF16PtrFromString(volatileName)
	if err != nil {
		return "", err
	}
	var h windows.Handle
	var disp uint32
	r, _, _ := procRegCreateKeyExW.Call(uintptr(parent), uintptr(unsafe.Pointer(name)), 0, 0,
		regOptionVolatile, uintptr(registry.QUERY_VALUE|registry.SET_VALUE|registry.WOW64_64KEY),
		uintptr(unsafe.Pointer(sa)), uintptr(unsafe.Pointer(&h)), uintptr(unsafe.Pointer(&disp)))
	if r != 0 {
		return "", fmt.Errorf("winapi: create volatile key: %w", windows.Errno(r))
	}
	k := registry.Key(h)
	defer k.Close() //nolint:errcheck // the value is written by SetStringValue
	if disp == regCreatedNewKey {
		return setBootID(k)
	}
	deadline := time.Now().Add(bootIDWait)
	for {
		v, _, err := k.GetStringValue(bootIDValue)
		if err == nil && v != "" {
			return v, nil
		}
		if err != nil && !errors.Is(err, registry.ErrNotExist) {
			return "", fmt.Errorf("winapi: read volatile boot id: %w", err)
		}
		if time.Now().After(deadline) {
			// The creator died before writing it.
			return setBootID(k)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func setBootID(k registry.Key) (string, error) {
	id := uuid.NewString()
	if err := k.SetStringValue(bootIDValue, id); err != nil {
		return "", fmt.Errorf("winapi: write volatile boot id: %w", err)
	}
	return id, nil
}
