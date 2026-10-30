//go:build !windows

package logx

import (
	"os"
	"testing"
)

func TestRotatingFileRenameFailure(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	// A read-only directory makes every rename fail.
	testRotationBlocked(t, func(t *testing.T, dir string) func() {
		if err := os.Chmod(dir, 0o500); err != nil {
			t.Fatal(err)
		}
		return func() {
			if err := os.Chmod(dir, 0o700); err != nil {
				t.Fatal(err)
			}
		}
	})
}
