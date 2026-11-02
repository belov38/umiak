//go:build !windows

package main

// connRefusedOS has nothing beyond ECONNREFUSED outside Windows.
func connRefusedOS(error) bool { return false }
