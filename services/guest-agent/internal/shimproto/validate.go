package shimproto

import "errors"

// MaxSessionLen is the longest accepted input session id.
const MaxSessionLen = 128

// MaxSignal is the highest signal number a kill or signal request may carry.
const MaxSignal = 64

// ErrSignalRange rejects a signal number outside 1..MaxSignal.
var ErrSignalRange = errors.New("signal out of range")

// ValidSession reports whether id matches [A-Za-z0-9._:-]{1,MaxSessionLen}.
// None of these bytes is escaped by encoding/json, so a session id costs
// its own length in a status reply.
func ValidSession(id string) bool {
	if id == "" || len(id) > MaxSessionLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '.', c == '_', c == ':', c == '-':
		default:
			return false
		}
	}
	return true
}

// CheckSignal returns ErrSignalRange for a signal number outside
// 1..MaxSignal.
func CheckSignal(sig int) error {
	if sig < 1 || sig > MaxSignal {
		return ErrSignalRange
	}
	return nil
}
