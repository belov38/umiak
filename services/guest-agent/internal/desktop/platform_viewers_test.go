package desktop

import (
	"context"
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
