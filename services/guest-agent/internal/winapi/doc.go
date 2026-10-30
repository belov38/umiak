// Package winapi wraps the Win32 and NT calls the Windows agent needs that
// golang.org/x/sys/windows lacks (LSA private data, permanent job objects,
// firmware tables, user profiles, ...). Procedures are resolved lazily from
// the system directory, so a missing export fails the call, not the agent's
// start. The package is empty on other platforms.
package winapi
