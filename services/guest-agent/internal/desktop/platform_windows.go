package desktop

import (
	"context"
	"errors"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// NativeSession opens the interactive OS desktop.
func NativeSession() (Session, error) {
	return nil, errors.New("Windows adapter follows in the separate Windows commit")
}
func secureSocket(string) error { return errors.New("Windows socket ACL adapter required") }

// PlatformEnvironment returns the platform display environment.
func PlatformEnvironment() map[string]string { return nil }

// NewPlatform constructs the OS session and streaming adapters.
func NewPlatform(paths.Layout, string) (Session, Streamer, func(context.Context) error, error) {
	return nil, PendingStreamer{}, nil, nil
}
