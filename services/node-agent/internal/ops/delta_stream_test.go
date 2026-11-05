package ops

import (
	"bytes"
	"encoding/json"
	"github.com/belov38/umiak/services/node-agent/internal/lvm"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func deltaHarness(t *testing.T, data []byte, staging bool) (*harness, string, string) {
	t.Helper()
	h := newHarness(nil)
	name := "base-599-disk-0"
	if staging {
		id := strings.Repeat("a", 32)
		name = "umiak-snap-" + id + "-scsi0"
		h.lvm.lvs = append(h.lvm.lvs, lvm.LV{Name: name, SizeBytes: uint64(len(data)), PoolLV: "data", Attr: "Vwi-a-tz--", Tags: []string{"umiak", "umiak-snap-" + id, "umiak-transfer-" + id}})
	} else {
		h.lvm.lvs[1].SizeBytes = uint64(len(data))
		h.lvm.lvs[1].Attr = "Vri---tz-k"
	}
	path := filepath.Join(t.TempDir(), "device")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	h.srv.TransferOpen = func(string) (*os.File, error) { return os.OpenFile(path, os.O_RDWR, 0) } //nolint:gosec // path is a device fixture under t.TempDir
	return h, name, path
}
func deltaRequest(name, mode string, size int, start int) []byte {
	b, _ := json.Marshal(deltaArgs{Mode: mode, Name: name, SizeBytes: uint64(size), VerifiedBytes: uint64(start), BaseChecksum: strings.Repeat("b", 64), Ranges: []byteRange{{0, uint64(size)}}}) //nolint:gosec // test sizes/checkpoints are small positive constants
	return b
}
func TestDeltaStreamReadbackZeroAndResume(t *testing.T) {
	data := bytes.Repeat([]byte{7}, deltaFrameMax+512*1024)
	clear(data[deltaFrameMax:])
	source, name, _ := deltaHarness(t, data, false)
	for _, start := range []int{0, 512 * 1024, len(data)} {
		before := bytes.Repeat([]byte{9}, len(data))
		copy(before[:start], data[:start])
		target, targetName, path := deltaHarness(t, before, true)
		var frames, acks bytes.Buffer
		if err := source.srv.DeltaStream(t.Context(), deltaRequest(name, "export", len(data), start), bytes.NewReader(nil), &frames); err != nil {
			t.Fatal(err)
		}
		if err := target.srv.DeltaStream(t.Context(), deltaRequest(targetName, "import", len(data), start), &frames, &acks); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(path) //nolint:gosec // path is a device fixture under t.TempDir
		if err != nil || !bytes.Equal(got, data) {
			t.Fatal("readback mismatch", err)
		}
		if acks.Len() < deltaHeaderSize {
			t.Fatal("missing final ack")
		}
	}
}
func TestDeltaStreamCorruptAndTruncatedFramesFailClosed(t *testing.T) {
	data := bytes.Repeat([]byte{7}, 512*1024)
	source, name, _ := deltaHarness(t, data, false)
	var frames bytes.Buffer
	if err := source.srv.DeltaStream(t.Context(), deltaRequest(name, "export", len(data), 0), bytes.NewReader(nil), &frames); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"corrupt", "truncate", "offset", "length", "flags"} {
		wire := bytes.Clone(frames.Bytes())
		switch kind {
		case "corrupt":
			wire[deltaHeaderSize+10] ^= 1
		case "truncate":
			wire = wire[:30]
		case "offset":
			wire[7] = 1
		case "length":
			wire[8] = 1
		case "flags":
			wire[15] = 128
		}
		target, targetName, path := deltaHarness(t, bytes.Repeat([]byte{9}, len(data)), true)
		var acks bytes.Buffer
		if err := target.srv.DeltaStream(t.Context(), deltaRequest(targetName, "import", len(data), 0), bytes.NewReader(wire), &acks); err == nil {
			t.Fatal("accepted", kind)
		}
		got, _ := os.ReadFile(path) //nolint:gosec // path is a device fixture under t.TempDir
		if !bytes.Equal(got, bytes.Repeat([]byte{9}, len(data))) {
			t.Fatal("wrote invalid frame", kind)
		}
	}
}
func TestDeltaStreamRefusesCorruptResumePrefixAndPublishedWrites(t *testing.T) {
	data := bytes.Repeat([]byte{7}, 512*1024)
	source, name, _ := deltaHarness(t, data, false)
	var frames bytes.Buffer
	if err := source.srv.DeltaStream(t.Context(), deltaRequest(name, "export", len(data), len(data)), bytes.NewReader(nil), &frames); err != nil {
		t.Fatal(err)
	}
	target, targetName, _ := deltaHarness(t, bytes.Repeat([]byte{9}, len(data)), true)
	if err := target.srv.DeltaStream(t.Context(), deltaRequest(targetName, "import", len(data), len(data)), &frames, &bytes.Buffer{}); err == nil {
		t.Fatal("accepted corrupt prefix")
	}
	if err := source.srv.DeltaStream(t.Context(), deltaRequest(name, "import", len(data), 0), bytes.NewReader(nil), &bytes.Buffer{}); err == nil {
		t.Fatal("allowed template write")
	}
}

func TestDeltaZeroFramesPreserveSparseHoles(t *testing.T) {
	data := make([]byte, 512*1024)
	source, name, _ := deltaHarness(t, data, false)
	target, targetName, path := deltaHarness(t, data, true)
	if e := os.Truncate(path, 0); e != nil {
		t.Fatal(e)
	}
	if e := os.Truncate(path, int64(len(data))); e != nil {
		t.Fatal(e)
	} //nolint:gosec // test fixture under t.TempDir
	var wire, acks bytes.Buffer
	if e := source.srv.DeltaStream(t.Context(), deltaRequest(name, "export", len(data), 0), bytes.NewReader(nil), &wire); e != nil {
		t.Fatal(e)
	}
	if e := target.srv.DeltaStream(t.Context(), deltaRequest(targetName, "import", len(data), 0), &wire, &acks); e != nil {
		t.Fatal(e)
	}
	info, e := os.Stat(path)
	if e != nil {
		t.Fatal(e)
	}
	if info.Sys().(*syscall.Stat_t).Blocks != 0 {
		t.Fatal("allocated an already-zero sparse hole")
	}
}
