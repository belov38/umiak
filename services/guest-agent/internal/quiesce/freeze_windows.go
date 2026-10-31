package quiesce

import "time"

// Platform behaviour of Quiesce on Windows (S9 spec 12.10): the QEMU guest
// agent freezes NTFS through VSS after Quiesce returns, so the agent freezes
// no filesystem (fs=true fails with fs_freeze_unsupported) and pauses no
// container (docker is ignored). Secret files live on NTFS and are wiped
// for a saved snapshot.
const (
	freezesFS = false
	// WipesSecretFiles is true: Quiesce honours wipe_secret_files and the
	// agent announces system.quiesce.wipe_secrets.v1.
	WipesSecretFiles = true
	// freezeBudget caps the agent's part of freeze() (watchdog start, the
	// PowerShell hooks at up to 5 s each, the secret file wipe). S1 allows
	// 30 s for the whole freeze() including VSS (spec 12.10), so the agent
	// keeps 10 s for fsfreeze-freeze. A shorter lease caps the steps at its
	// deadline instead.
	freezeBudget = 20 * time.Second
)

// NewFreezer returns nil: Windows has no FIFREEZE, and a nil Freezer
// skips the freeze (the agent, the watchdog and thaw --force).
func NewFreezer() Freezer {
	return nil
}

// syncAll is not needed: the agent never freezes a filesystem here.
func syncAll() {}
