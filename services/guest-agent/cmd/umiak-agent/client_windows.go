package main

import (
	"errors"

	"golang.org/x/sys/windows"
)

// connRefusedOS matches the Winsock refusal of an AF_UNIX connect.
func connRefusedOS(err error) bool {
	return errors.Is(err, windows.WSAECONNREFUSED)
}
