package files

// renameNoReplace renames src to dst unless dst exists: MoveFileExW
// without REPLACE_EXISTING refuses an existing dst atomically.
func renameNoReplace(src, dst string) error {
	return placeNew(src, dst)
}
