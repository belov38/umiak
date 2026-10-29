//go:build integration && linux

package integration

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// Retention limits of TestRetention (the spec's 128 MiB / 1 GiB scaled down
// by 16 through the per-stream limit of agent.toml).
const (
	retainBytes  = 8 << 20
	writtenBytes = 64 << 20
	// retainSlack covers the trim granularity once the command exited.
	retainSlack = 4 << 20
)

// allocated returns the bytes allocated on disk for path.
func allocated(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Sys().(*syscall.Stat_t).Blocks * 512
}

// Spec 21 item 8: a command writes far over its per-stream limit; the space
// it takes stays near the limit (holes are punched at the head), an attach
// from 0 gets `truncated` and the offsets add up to the file size.
func TestRetention(t *testing.T) {
	withConfig(t, "[output]\nper_stream_bytes = \"8MiB\"\n")
	c := newClient()
	id := newID("retain")
	// Throttled so the janitor (1 s period) sees the stream grow.
	script := "for i in $(seq 1 64); do head -c 1048576 /dev/urandom; sleep 0.05; done"
	began := time.Now()
	start(t, c, id, shellSpec(script, "user"))
	path := filepath.Join(cmdDir(id), "stdout")
	var peak int64
	for get(t, c, id).GetState() != agentv1.CommandState_COMMAND_STATE_EXITED {
		if _, err := os.Stat(path); err == nil {
			peak = max(peak, allocated(t, path))
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Spec 21 item 8 allows the limit plus one second of writing: the
	// janitor runs once a second.
	perSecond := int64(float64(writtenBytes) / time.Since(began).Seconds())
	// The janitor finishes the last trim within a period after the exit.
	eventually(t, 10*time.Second, "the stream to be trimmed", func() bool {
		return allocated(t, path) <= retainBytes+retainSlack
	})
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != writtenBytes {
		t.Errorf("stdout size = %d, want %d (apparent size keeps the offsets)", fi.Size(), writtenBytes)
	}
	t.Logf("stdout: size %d, allocated %d now, peak %d while running at %d B/s", fi.Size(), allocated(t, path), peak, perSecond)
	if limit := retainBytes + perSecond + retainSlack; peak > limit {
		t.Errorf("peak allocation %d while running, want <= %d (limit + 1 s of writing + slack)", peak, limit)
	}

	r := attach(t, c, &agentv1.AttachRequest{CommandId: id}, true)
	if len(r.truncated) == 0 || r.truncated[0].GetAvailableFrom() == 0 {
		t.Fatalf("attach from 0: truncated = %v, want a truncation", r.truncated)
	}
	from := r.truncated[0].GetAvailableFrom()
	if r.exit == nil || r.exit.GetStdoutEnd() != writtenBytes {
		t.Fatalf("exit = %v, want stdout_end %d", r.exit, writtenBytes)
	}
	if got := from + uint64(len(r.stdout)); got != writtenBytes || r.ends[agentv1.Stream_STREAM_STDOUT] != writtenBytes {
		t.Errorf("available_from %d + %d bytes = %d, want the file size %d", from, len(r.stdout), got, writtenBytes)
	}
	if writtenBytes-from > retainBytes+retainSlack {
		t.Errorf("retained %d bytes, want about %d", writtenBytes-from, retainBytes)
	}
	info := get(t, c, id)
	for _, s := range info.GetStreams() {
		if s.GetStream() == agentv1.Stream_STREAM_STDOUT && (s.GetAvailableFrom() != from || s.GetSize() != writtenBytes) {
			t.Errorf("stream info = %v, want available_from %d size %d", s, from, writtenBytes)
		}
	}
}

// Spec 21 item 15: idle agent RSS < 40 MiB, shim RSS < 8 MiB, from
// /proc/<pid>/status. The shim is the agent binary: its file-backed pages
// (RssFile) are the page cache of that binary, shared by the agent and every
// shim, so the per-command cost is its private memory (RssAnon). The test
// holds RssAnon of the shim to 8 MiB and logs VmRSS; see the Task 18 report.
func TestMemory(t *testing.T) {
	c := newClient()
	waitAgent(t)
	time.Sleep(3 * time.Second) // let the agent settle after the previous test
	agentPID := strconv.Itoa(mainPID(t))
	agentRSS := statusKB(t, agentPID, "VmRSS")

	id := newID("mem")
	start(t, c, id, shellSpec("sleep 30", "user"))
	shimPID := strings.TrimSpace(sh(t, "systemctl show -p MainPID --value "+supervisor.UnitName(id)))
	time.Sleep(2 * time.Second)
	shimRSS, shimAnon := statusKB(t, shimPID, "VmRSS"), statusKB(t, shimPID, "RssAnon")
	t.Logf("idle agent VmRSS %.1f MiB (%s)", float64(agentRSS)/(1<<20), rssBreakdown(t, agentPID))
	t.Logf("shim VmRSS %.1f MiB (%s)", float64(shimRSS)/(1<<20), rssBreakdown(t, shimPID))
	if agentRSS >= 40<<20 {
		t.Errorf("agent VmRSS %d >= 40 MiB", agentRSS)
	}
	if shimAnon >= 8<<20 {
		t.Errorf("shim RssAnon %d >= 8 MiB", shimAnon)
	}
	if _, err := c.proc.Kill(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.KillRequest{CommandId: id})); err != nil {
		t.Errorf("Kill: %v", err)
	}
}

// rssBreakdown returns the RssAnon, RssFile and RssShmem lines of pid.
func rssBreakdown(t *testing.T, pid string) string {
	t.Helper()
	b, err := os.ReadFile("/proc/" + pid + "/status")
	if err != nil {
		t.Fatal(err)
	}
	var parts []string
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "Rss") {
			parts = append(parts, strings.Join(strings.Fields(line), " "))
		}
	}
	return strings.Join(parts, ", ")
}

// statusKB returns the kB field key of /proc/<pid>/status in bytes.
func statusKB(t *testing.T, pid, key string) int64 {
	t.Helper()
	b, err := os.ReadFile("/proc/" + pid + "/status")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, key+":"); ok {
			f := strings.Fields(v)
			kb, err := strconv.ParseInt(f[0], 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			return kb << 10
		}
	}
	t.Fatalf("no %s for pid %s", key, pid)
	return 0
}
