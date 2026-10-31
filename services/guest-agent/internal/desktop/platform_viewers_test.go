package desktop

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestViewerLifecycleLogWinsOverStaleConntrack(t *testing.T) {
	flow := "udp 17 119 src=127.0.0.1 dst=127.0.0.1 sport=53555 dport=47999 src=127.0.0.1 dst=127.0.0.1 sport=47999 dport=53555 [ASSURED]\n"
	for _, closed := range []bool{false, true} {
		dir := t.TempDir()
		log := "Info: CLIENT CONNECTED\n"
		want := uint32(1)
		if closed {
			log += "Info: CLIENT DISCONNECTED\n"
			want = 0
		}
		if e := os.WriteFile(filepath.Join(dir, "sunshine.log"), []byte(log), 0600); e != nil {
			t.Fatal(e)
		}
		calls := 0
		host := &FileHost{SunDir: dir, Run: func(context.Context, string, ...string) ([]byte, error) {
			calls++
			return []byte(strings.Repeat(flow, 3)), nil
		}}
		got, e := host.Viewers(t.Context())
		if e != nil || got != want {
			t.Fatalf("closed=%v: viewers=%d, want=%d, error=%v", closed, got, want, e)
		}
		if calls != 0 {
			t.Fatal("authoritative lifecycle log must not be overridden by stale UDP state")
		}
	}
	host := &FileHost{SunDir: t.TempDir(), Run: func(context.Context, string, ...string) ([]byte, error) { return []byte(flow), nil }}
	if got, e := host.Viewers(t.Context()); e != nil || got != 1 {
		t.Fatalf("missing-log fallback: %d %v", got, e)
	}
}

func TestRecentControlTrafficWinsOverUnbalancedSunshineEvents(t *testing.T) {
	flow := func(ttl int) string {
		return fmt.Sprintf("udp 17 %d src=127.0.0.1 dst=127.0.0.1 sport=53555 dport=47999 src=127.0.0.1 dst=127.0.0.1 sport=47999 dport=53555 [ASSURED]\n", ttl)
	}
	for _, active := range []bool{false, true} {
		dir := t.TempDir()
		if e := os.WriteFile(filepath.Join(dir, "sunshine.log"), []byte(strings.Repeat("Info: CLIENT CONNECTED\n", 3)), 0600); e != nil {
			t.Fatal(e)
		}
		data := flow(100) + flow(90)
		want := uint32(0)
		if active {
			data += flow(119)
			want = 1
		}
		host := &FileHost{SunDir: dir, FlowTimeout: func() (uint32, error) { return 120, nil }, Run: func(context.Context, string, ...string) ([]byte, error) { return []byte(data), nil }}
		if got, e := host.Viewers(t.Context()); e != nil || got != want {
			t.Fatalf("active=%v: got=%d want=%d error=%v", active, got, want, e)
		}
	}
}
