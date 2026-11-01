package desktop

import "context"

// Environment contributes only non-secret display coordinates to exec and PAM.
type Environment struct{}

// Name identifies the desktop extension.
func (Environment) Name() string { return "desktop" }

// PlatformEnv adds the non-secret session environment.
func (Environment) PlatformEnv() map[string]string { return PlatformEnvironment() }

// Phases declares desktop readiness.
func (Environment) Phases() []string { return []string{"desktop"} }

// AfterClaim leaves startup to the secrets readiness gate.
func (Environment) AfterClaim(context.Context, bool) error { return nil }
