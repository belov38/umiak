//go:build race

package e2e_test

// raceEnabled skips the heap assertion of TestBigTransfer: the race
// detector makes memory noisy.
const raceEnabled = true
