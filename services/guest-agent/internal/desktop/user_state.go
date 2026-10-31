package desktop

import (
	"context"
	"path/filepath"
)

// ownUserDesktopParents repairs only the two generated XDG parent directories;
// never recursively chown unrelated application state in the user's home.
func ownUserDesktopParents(ctx context.Context, sunDir string, run RunCommand) error {
	for _, dir := range []string{filepath.Dir(sunDir), filepath.Dir(filepath.Dir(sunDir))} {
		if _, err := run(ctx, "chown", "user:user", dir); err != nil {
			return err
		}
	}
	return nil
}
