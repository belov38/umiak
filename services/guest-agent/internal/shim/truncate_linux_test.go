//go:build linux

package shim

import (
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

// quotaWriter writes to f until room bytes are used, then fails with errno
// like a full disk: a write that does not fit is cut short.
type quotaWriter struct {
	f     *os.File
	room  int
	errno unix.Errno
}

func (w *quotaWriter) Write(p []byte) (int, error) {
	if len(p) <= w.room {
		w.room -= len(p)
		return w.f.Write(p)
	}
	n, err := w.f.Write(p[:w.room])
	w.room = 0
	if err != nil {
		return n, err
	}
	return n, &fs.PathError{Op: "write", Path: w.f.Name(), Err: w.errno}
}

// pipeStream returns a stream whose fd is the non-blocking read end of a
// pipe, its log file, and the write end.
func pipeStream(t *testing.T, dir, name string) (*stream, *os.File, int) {
	t.Helper()
	var p [2]int
	if err := unix.Pipe2(p[:], unix.O_NONBLOCK|unix.O_CLOEXEC); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Close(p[0]); _ = unix.Close(p[1]) })
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return &stream{name: name, file: f, out: f, fd: p[0]}, f, p[1]
}

func TestCopyDropsOutputOnFullDisk(t *testing.T) {
	dir := t.TempDir()
	s := newShim(slog.New(slog.NewTextHandler(io.Discard, nil)), paths.ForRoot(dir), "c1")
	out, outFile, outW := pipeStream(t, dir, StdoutFile)
	errSt, _, errW := pipeStream(t, dir, StderrFile)
	s.streams = []*stream{out, errSt}
	qw := &quotaWriter{f: outFile, room: 30, errno: unix.ENOSPC}
	out.out = qw
	buf := make([]byte, 64)

	// 100 bytes on stdout, 30 fit: 70 dropped, the pipe is drained anyway.
	if _, err := unix.Write(outW, make([]byte, 100)); err != nil {
		t.Fatal(err)
	}
	if _, err := unix.Write(errW, []byte("fine")); err != nil {
		t.Fatal(err)
	}
	s.copy(out, buf, 0)
	s.copy(errSt, buf, 0)
	if n, err := unix.Read(out.fd, buf); n > 0 || err != unix.EAGAIN {
		t.Fatalf("pipe not drained: n=%d err=%v", n, err)
	}

	// Room again (space freed): later output is written, the drop stays.
	qw.room = 1 << 20
	if _, err := unix.Write(outW, []byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	s.copy(out, buf, 0)

	var e ExitFile
	s.setEnds(&e)
	if e.StdoutEnd != 40 || e.StderrEnd != 4 {
		t.Errorf("ends = %d/%d, want 40/4 (the written bytes)", e.StdoutEnd, e.StderrEnd)
	}
	if fi, _ := os.Stat(outFile.Name()); fi.Size() != e.StdoutEnd {
		t.Errorf("stdout size %d != end %d", fi.Size(), e.StdoutEnd)
	}
	if e.OutputTruncated != shimproto.TruncatedDiskFull {
		t.Errorf("OutputTruncated = %q", e.OutputTruncated)
	}
	if want := map[string]uint64{StdoutFile: 70}; !reflect.DeepEqual(e.DroppedBytes, want) {
		t.Errorf("DroppedBytes = %v, want %v", e.DroppedBytes, want)
	}

	r := s.handleStatus()
	if r.OutputTruncated != shimproto.TruncatedDiskFull || r.DroppedBytes[StdoutFile] != 70 {
		t.Errorf("status = %q %v", r.OutputTruncated, r.DroppedBytes)
	}
}

func TestCopyOtherWriteErrorNotTruncation(t *testing.T) {
	dir := t.TempDir()
	s := newShim(slog.New(slog.NewTextHandler(io.Discard, nil)), paths.ForRoot(dir), "c1")
	out, outFile, outW := pipeStream(t, dir, StdoutFile)
	s.streams = []*stream{out}
	out.out = &quotaWriter{f: outFile, room: 0, errno: unix.EIO}
	if _, err := unix.Write(outW, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	s.copy(out, make([]byte, 64), 0)
	var e ExitFile
	s.setEnds(&e)
	if e.OutputTruncated != "" || e.DroppedBytes != nil {
		t.Errorf("EIO reported as truncation: %q %v", e.OutputTruncated, e.DroppedBytes)
	}
}

func TestDiskQuotaCountsAsFull(t *testing.T) {
	dir := t.TempDir()
	s := newShim(slog.New(slog.NewTextHandler(io.Discard, nil)), paths.ForRoot(dir), "c1")
	pty, f, w := pipeStream(t, dir, PtyFile)
	s.streams = []*stream{pty}
	pty.out = &quotaWriter{f: f, room: 0, errno: unix.EDQUOT}
	if _, err := unix.Write(w, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	s.copy(pty, make([]byte, 64), 0)
	if reason, d := s.truncation(); reason != shimproto.TruncatedDiskFull || d[PtyFile] != 3 {
		t.Errorf("truncation = %q %v", reason, d)
	}
}
