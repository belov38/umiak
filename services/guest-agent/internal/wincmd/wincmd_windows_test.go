package wincmd

import (
	"slices"
	"testing"

	"golang.org/x/sys/windows"
)

// The portable copies match x/sys/windows and survive CommandLineToArgvW.
func TestComposeArgsMatchesWindows(t *testing.T) {
	args := [][]string{
		{"prog"},
		{`C:\Program Files\x.exe`, "", "a b", `say "hi"`, `C:\my dir\`, `a\\"b`, "\t", `\\server\s`, "ü 🙂"},
		{`"q"`, "x"},
	}
	for _, a := range args {
		got := ComposeArgs(a)
		if want := windows.ComposeCommandLine(a); got != want {
			t.Errorf("ComposeArgs(%q) = %s, windows %s", a, got, want)
		}
		for _, s := range a[1:] {
			if EscapeArg(s) != windows.EscapeArg(s) {
				t.Errorf("EscapeArg(%q) = %s, windows %s", s, EscapeArg(s), windows.EscapeArg(s))
			}
		}
		back, err := windows.DecomposeCommandLine(got)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(back[1:], a[1:]) {
			t.Errorf("round trip of %q = %q", a, back)
		}
	}
}
