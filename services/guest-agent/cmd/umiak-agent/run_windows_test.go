package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFinalPathPlainFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.exe")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := finalPath(p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(got, `\\?\`) || !strings.EqualFold(filepath.Base(got), "x.exe") {
		t.Errorf("finalPath = %q", got)
	}
	if fi1, err := os.Stat(got); err != nil {
		t.Error(err)
	} else if fi2, _ := os.Stat(p); !os.SameFile(fi1, fi2) {
		t.Errorf("finalPath %q is another file than %q", got, p)
	}
}
