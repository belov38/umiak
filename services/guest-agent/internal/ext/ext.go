// Package ext is the seam for optional agent extensions such as the desktop
// (S10). The agent wires an empty list for now; no extension is implemented.
package ext

import "context"

// Extension adds platform env, readiness phases and post-claim work.
type Extension interface {
	// Name identifies the extension in logs.
	Name() string
	// PlatformEnv returns env added after the platform defaults and before
	// the claim env (spec 8.2, step 2). Values must not be secret.
	PlatformEnv() map[string]string
	// Phases lists the readiness phases the extension reports.
	Phases() []string
	// AfterClaim runs after a claim (first set) or a re-applied claim
	// (RESUME/RECOVER) was applied. An error is logged; the extension
	// reports its own state through its phases.
	AfterClaim(ctx context.Context, first bool) error
}
