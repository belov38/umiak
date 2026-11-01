package gateway

import (
	"bytes"
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
)

// logBuffer collects log output safely across goroutines.
type logBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// Capabilities are agent-controlled: oversized sets are not stored, and an
// Info response above the Control read limit is refused by the transport.
func TestCapabilitiesBounded(t *testing.T) {
	e := newEnv(t)
	var logs logBuffer
	e.gateway("gw-a", func(c *Config) { c.Logger = slog.New(slog.NewTextHandler(&logs, nil)) })

	// The total binds for long lists: count x per-entry max exceeds it.
	if maxCapabilities*maxCapabilityBytes <= maxCapabilitiesTotal || 100 > maxCapabilities || 1<<10 > maxCapabilityBytes {
		t.Fatalf("limits: %d x %d bytes do not exceed the %d total, or the over-total case is not within count and entry limits",
			maxCapabilities, maxCapabilityBytes, maxCapabilitiesTotal)
	}
	many := make([]string, maxCapabilities+1)
	for i := range many {
		many[i] = "cap"
	}
	cases := []struct {
		name  string
		info  *tunnelv1.InfoResponse
		store bool
		log   string // expected in the gateway log
	}{
		{"ok", &tunnelv1.InfoResponse{Capabilities: []string{"process.pty", "files.upload.v1"}}, true, ""},
		{"max count", &tunnelv1.InfoResponse{Capabilities: slices.Repeat([]string{strings.Repeat("c", maxCapabilitiesTotal/maxCapabilities)}, maxCapabilities)}, true, ""},
		{"max total", &tunnelv1.InfoResponse{Capabilities: slices.Repeat([]string{strings.Repeat("c", 1<<10)}, maxCapabilitiesTotal/(1<<10))}, true, ""},
		// Within the count and per-entry limits, over the total.
		{"over total", &tunnelv1.InfoResponse{Capabilities: slices.Repeat([]string{strings.Repeat("c", 1<<10)}, 100)}, false, "capabilities over the limits"},
		{"too many", &tunnelv1.InfoResponse{Capabilities: many}, false, "capabilities over the limits"},
		{"too long", &tunnelv1.InfoResponse{Capabilities: []string{strings.Repeat("c", maxCapabilityBytes+1)}}, false, "capabilities over the limits"},
		{"huge info", &tunnelv1.InfoResponse{Os: strings.Repeat("x", 2<<20), Capabilities: []string{"a"}}, false, "Control/Info failed"},
	}
	for _, tc := range cases {
		id, bs := e.machine()
		cfg := agentConfig(e, id, bs, defaultIdentity())
		info := tc.info
		cfg.Info = func(context.Context) *tunnelv1.InfoResponse { return info }
		e.startAgent(cfg).waitConnected()
		// The bootstrap login rotates the token right after Info.
		eventually(t, waitTimeout, tc.name+": token rotated", func() bool {
			mt, next := e.credentials(id)
			return mt != nil && next == nil
		})
		s := e.session(id)
		if s.CapabilitiesKnown != tc.store {
			t.Errorf("%s: capabilities stored = %v, want %v", tc.name, s.CapabilitiesKnown, tc.store)
		}
		if tc.store && !slices.Equal(s.Capabilities, tc.info.GetCapabilities()) {
			t.Errorf("%s: stored %d capabilities, want %d", tc.name, len(s.Capabilities), len(tc.info.GetCapabilities()))
		}
		if tc.log != "" && !strings.Contains(logs.String(), tc.log) {
			t.Errorf("%s: no %q warning in the log", tc.name, tc.log)
		}
	}
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, "capabilities over the limits") {
			t.Log(l)
		}
	}
}
