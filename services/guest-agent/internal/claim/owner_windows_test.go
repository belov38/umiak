package claim

import "testing"

func ownerUID(t *testing.T, _ string) uint32 {
	t.Helper()
	t.Skip("file ownership is not observable on Windows")
	return 0
}

// testLinkPath is the link_path of fullRequest; Rooted maps it under the
// harness root.
const testLinkPath = `C:\Users\user\.config\key.pem`
