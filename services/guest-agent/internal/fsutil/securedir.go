package fsutil

// DirAccess selects who may use an agent directory (S9 spec 12.1). On
// Windows it is a protected DACL inherited by everything below; elsewhere
// the directory is 0700 for its owner.
type DirAccess int

const (
	// SystemOnly is SYSTEM only (state\).
	SystemOnly DirAccess = iota
	// SystemAndAdmins is SYSTEM and Administrators (run\: the admin socket
	// lives there; env.sock adds the default user on the file itself).
	SystemAndAdmins
)
