package shimproto

import (
	"errors"
	"strings"
	"testing"
)

func TestValidSession(t *testing.T) {
	tests := []struct {
		id string
		ok bool
	}{
		{"a", true},
		{"Az09._:-", true},
		{strings.Repeat("x", MaxSessionLen), true},
		{"", false},
		{strings.Repeat("x", MaxSessionLen+1), false},
		{"a<b", false},
		{"a&b", false},
		{"a b", false},
		{"a/b", false},
		{"a\x00", false},
		{"é", false},
	}
	for _, tt := range tests {
		if got := ValidSession(tt.id); got != tt.ok {
			t.Errorf("ValidSession(%q) = %v, want %v", tt.id, got, tt.ok)
		}
	}
}

func TestCheckSignal(t *testing.T) {
	tests := []struct {
		sig int
		ok  bool
	}{
		{1, true}, {9, true}, {MaxSignal, true}, {0, false}, {-1, false}, {MaxSignal + 1, false},
	}
	for _, tt := range tests {
		err := CheckSignal(tt.sig)
		if (err == nil) != tt.ok || (err != nil && !errors.Is(err, ErrSignalRange)) {
			t.Errorf("CheckSignal(%d) = %v, want ok=%v", tt.sig, err, tt.ok)
		}
	}
}
