package claim

import "testing"

func ownerUID(t *testing.T, _ string) uint32 {
	t.Helper()
	t.Skip("file ownership is not observable on Windows")
	return 0
}
