package winapi

import (
	"errors"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// systemTimeOfDayInformation is SYSTEM_TIMEOFDAY_INFORMATION.
type systemTimeOfDayInformation struct {
	BootTime      int64
	CurrentTime   int64
	TimeZoneBias  int64
	TimeZoneID    uint32
	Reserved      uint32
	BootTimeBias  uint64
	SleepTimeBias uint64
}

// KernelBootTime returns the boot time the kernel keeps
// (NtQuerySystemInformation(SystemTimeOfDayInformation).BootTime). The
// kernel moves it when the system clock is set, so it is stable only to
// the extent the clock is.
func KernelBootTime() (time.Time, error) {
	var info systemTimeOfDayInformation
	var n uint32
	if err := windows.NtQuerySystemInformation(windows.SystemTimeOfDayInformation,
		unsafe.Pointer(&info), uint32(unsafe.Sizeof(info)), &n); err != nil {
		return time.Time{}, err
	}
	if info.BootTime <= 0 {
		return time.Time{}, errors.New("winapi: no kernel boot time")
	}
	ft := windows.Filetime{LowDateTime: uint32(info.BootTime), HighDateTime: uint32(info.BootTime >> 32)} //nolint:gosec // split of a FILETIME
	return time.Unix(0, ft.Nanoseconds()).UTC(), nil
}
