package winapi

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestSystemDLLsLoad(t *testing.T) {
	for _, d := range []*windows.LazyDLL{modkernel32, modadvapi32, modntdll, modnetapi32, moduserenv} {
		if err := d.Load(); err != nil {
			t.Errorf("load %s: %v", d.Name, err)
		}
	}
}
