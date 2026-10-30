package supervisor

import (
	"errors"
	"strings"
	"testing"
)

func TestReadReady(t *testing.T) {
	if err := readReady(strings.NewReader("READY\n")); err != nil {
		t.Fatalf("READY: %v", err)
	}
	if err := readReady(strings.NewReader("READY\r\n")); err != nil {
		t.Fatalf("READY with CRLF: %v", err)
	}
	err := readReady(strings.NewReader("FAIL shim: bad spec\n"))
	if err == nil || !strings.Contains(err.Error(), "shim: bad spec") || errors.Is(err, ErrUnitExists) {
		t.Fatalf("FAIL: %v", err)
	}
	if err := readReady(strings.NewReader("FAIL already started: job sbx-cmd-c1 exists\n")); !errors.Is(err, ErrUnitExists) {
		t.Fatalf("FAIL already started: %v, want ErrUnitExists", err)
	}
	for _, in := range []string{"", "READ", "garbage\n", "FAIL"} {
		if err := readReady(strings.NewReader(in)); err == nil {
			t.Errorf("%q: want an error", in)
		}
	}
}
