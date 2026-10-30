package files

// resolveOS resolves a non-empty path without NUL bytes by the Windows
// rules (windowsPath).
func resolveOS(p, home string) (string, error) {
	return windowsPath(p, home)
}
