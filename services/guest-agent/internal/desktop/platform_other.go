//go:build !linux && !windows

package desktop

import (
	"context"
	"errors"
	"os"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// NativeSession opens the interactive OS desktop.
func NativeSession() (Session, error) {
	return nil, errors.New("desktop helper requires Linux or Windows")
}
func secureSocket(path string) error { return os.Chmod(path, 0600) }

// PlatformEnvironment returns the platform display environment.
func PlatformEnvironment() map[string]string { return nil }

// NewPlatform constructs the OS session and streaming adapters.
func NewPlatform(paths.Layout, string) (Session, Streamer, func(context.Context) error, error) {
	return nil, PendingStreamer{}, nil, nil
}
