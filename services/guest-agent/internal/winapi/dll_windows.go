package winapi

import "golang.org/x/sys/windows"

// System DLLs, loaded from System32 on first use. Each file of this package
// declares its procedures next to their wrappers.
var (
	modkernel32 = windows.NewLazySystemDLL("kernel32.dll")
	modadvapi32 = windows.NewLazySystemDLL("advapi32.dll")
	modntdll    = windows.NewLazySystemDLL("ntdll.dll")
	modnetapi32 = windows.NewLazySystemDLL("netapi32.dll")
	moduserenv  = windows.NewLazySystemDLL("userenv.dll")
)
