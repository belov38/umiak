//go:build !linux

package files

// renameNoReplace renames src to dst unless dst exists. Without
// renameat2 the check and the rename are separate calls.
func renameNoReplace(src, dst string) error {
	return renameCheckFirst(src, dst)
}
