//go:build !windows

package claim

import (
	"os"
	"syscall"
	"testing"
)

func ownerUID(t *testing.T, path string) uint32 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Sys().(*syscall.Stat_t).Uid
}

// testLinkPath is the link_path of fullRequest.
const testLinkPath = "/home/user/.config/key.pem"
