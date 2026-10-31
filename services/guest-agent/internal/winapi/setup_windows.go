package winapi

import (
	"fmt"

	"golang.org/x/sys/windows/registry"
)

const setupStateKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State`

// ImageStateComplete is the ImageState of a Windows installation whose setup
// (specialize and OOBE after sysprep) has finished.
const ImageStateComplete = "IMAGE_STATE_COMPLETE"

// ImageState returns the ImageState value of the setup state key, for
// example IMAGE_STATE_SPECIALIZE_RESEAL_TO_OOBE while a sysprepped image
// goes through setup.
func ImageState() (string, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, setupStateKey, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return "", fmt.Errorf("winapi: open setup state: %w", err)
	}
	defer k.Close() //nolint:errcheck // read-only use
	v, _, err := k.GetStringValue("ImageState")
	if err != nil {
		return "", fmt.Errorf("winapi: read ImageState: %w", err)
	}
	return v, nil
}
