//go:build !race

package httpproxy_test

const (
	uploadSize  = 512 << 20
	raceEnabled = false
)
