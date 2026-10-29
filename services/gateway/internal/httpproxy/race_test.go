//go:build race

package httpproxy_test

// The race detector makes the large upload slow and its memory noisy: a
// smaller body, sha256 still checked, no heap assertion.
const (
	uploadSize  = 64 << 20
	raceEnabled = true
)
