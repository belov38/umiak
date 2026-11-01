package desktop

import "path/filepath"

// aclCommands returns the icacls invocations that give SYSTEM and account full
// access to path. Inheritable grants go on a directory only: icacls /T would put
// the (OI)(CI) ACEs on files as inherit-only entries, leaving them unreadable
// even for SYSTEM. Existing children are reset to inherit from the directory.
func aclCommands(path, account string, isDir bool, children []string) [][]string {
	rights := "F"
	if isDir {
		rights = "(OI)(CI)F"
	}
	cmds := [][]string{{path, "/inheritance:r", "/grant:r", "*S-1-5-18:" + rights, account + ":" + rights, "/Q"}}
	for _, c := range children {
		cmds = append(cmds, []string{filepath.Join(path, c), "/reset", "/T", "/Q"})
	}
	return cmds
}
