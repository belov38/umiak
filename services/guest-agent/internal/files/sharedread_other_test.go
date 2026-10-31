//go:build !windows

package files

import "os"

// readShared is os.ReadFile: a rename replaces a file that others hold open.
func readShared(path string) ([]byte, error) { return os.ReadFile(path) }
