package winapi

import (
	"errors"
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

func TestJobAndConsoleProcsResolve(t *testing.T) {
	for _, p := range []*windows.LazyProc{
		procNtCreateJobObject, procNtMakeTemporaryObject,
		procCreateJobObjectW, procOpenJobObjectW, procAttachConsole, procFreeConsole, procUpdateProcThreadAttribute,
	} {
		if err := p.Find(); err != nil {
			t.Errorf("find %s: %v", p.Name, err)
		}
	}
}

func TestOpenJobObjectMissing(t *testing.T) {
	_, err := OpenJobObject(windows.SYNCHRONIZE, false, `Global\sbx-test-no-such-job`)
	if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		t.Fatalf("OpenJobObject of a missing job: %v", err)
	}
}
