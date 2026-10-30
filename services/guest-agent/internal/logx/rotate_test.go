package logx

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeLines(t *testing.T, w interface{ Write([]byte) (int, error) }, from, to int) {
	t.Helper()
	for i := from; i < to; i++ {
		if _, err := fmt.Fprintf(w, "line %03d\n", i); err != nil {
			t.Fatal(err)
		}
	}
}

func logFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestRotatingFileRotatesAtLimit(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs")
	// Each line is 9 bytes, so 4 lines fit in 40 bytes.
	w, err := NewRotatingFile(dir, "agent.log", 40, 3)
	if err != nil {
		t.Fatal(err)
	}
	writeLines(t, w, 0, 30)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "agent.log.1")); err != nil {
		t.Fatalf("agent.log.1: %v", err)
	}
	if got, want := logFiles(t, dir), []string{"agent.log", "agent.log.1", "agent.log.2"}; !reflect.DeepEqual(got, want) {
		t.Errorf("files = %v, want %v", got, want)
	}
	for _, name := range logFiles(t, dir) {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Size() > 40 {
			t.Errorf("%s is %d bytes, over the 40 byte limit", name, fi.Size())
		}
	}
	// The newest records are in agent.log, the older ones in .1 and .2.
	cur, _ := os.ReadFile(filepath.Join(dir, "agent.log"))
	if want := "line 028\nline 029\n"; string(cur) != want {
		t.Errorf("agent.log = %q, want %q", cur, want)
	}
	prev, _ := os.ReadFile(filepath.Join(dir, "agent.log.1"))
	if want := "line 024\nline 025\nline 026\nline 027\n"; string(prev) != want {
		t.Errorf("agent.log.1 = %q, want %q", prev, want)
	}
}

func TestRotatingFileAppendsAfterReopen(t *testing.T) {
	dir := t.TempDir()
	w, err := NewRotatingFile(dir, "agent.log", 40, 2)
	if err != nil {
		t.Fatal(err)
	}
	writeLines(t, w, 0, 3)
	_ = w.Close()

	// The existing size counts toward the limit after a restart.
	w, err = NewRotatingFile(dir, "agent.log", 40, 2)
	if err != nil {
		t.Fatal(err)
	}
	writeLines(t, w, 3, 5)
	_ = w.Close()
	cur, _ := os.ReadFile(filepath.Join(dir, "agent.log"))
	if want := "line 004\n"; string(cur) != want {
		t.Errorf("agent.log = %q, want %q", cur, want)
	}
	prev, _ := os.ReadFile(filepath.Join(dir, "agent.log.1"))
	if want := "line 000\nline 001\nline 002\nline 003\n"; string(prev) != want {
		t.Errorf("agent.log.1 = %q, want %q", prev, want)
	}
}

func TestRotatingFileKeepOne(t *testing.T) {
	dir := t.TempDir()
	w, err := NewRotatingFile(dir, "agent.log", 20, 1)
	if err != nil {
		t.Fatal(err)
	}
	writeLines(t, w, 0, 5)
	_ = w.Close()
	if got, want := logFiles(t, dir), []string{"agent.log"}; !reflect.DeepEqual(got, want) {
		t.Errorf("files = %v, want %v", got, want)
	}
	cur, _ := os.ReadFile(filepath.Join(dir, "agent.log"))
	if want := "line 004\n"; string(cur) != want {
		t.Errorf("agent.log = %q, want %q", cur, want)
	}
}

func TestRotatingFileRenameFailure(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := t.TempDir()
	w, err := NewRotatingFile(dir, "agent.log", 40, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	writeLines(t, w, 0, 4)
	// A read-only directory makes every rename fail, like a log file held
	// open by a reader on Windows.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	writeLines(t, w, 4, 12)
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if got, want := logFiles(t, dir), []string{"agent.log"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("files = %v, want %v", got, want)
	}
	// Rotation failed at lines 4 and 8: after a failure the next attempt
	// waits for another 40 bytes. All lines stay in agent.log.
	cur, _ := os.ReadFile(filepath.Join(dir, "agent.log"))
	if len(cur) != 12*9 {
		t.Errorf("agent.log has %d bytes, want all 12 lines", len(cur))
	}
	// Line 12 rotates successfully.
	writeLines(t, w, 12, 16)
	if got, want := logFiles(t, dir), []string{"agent.log", "agent.log.1"}; !reflect.DeepEqual(got, want) {
		t.Errorf("files = %v, want %v", got, want)
	}
}

func TestRotatingFileWriteAfterClose(t *testing.T) {
	w, err := NewRotatingFile(t.TempDir(), "agent.log", 40, 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("x\n")); !errors.Is(err, fs.ErrClosed) {
		t.Errorf("Write after Close = %v, want fs.ErrClosed", err)
	}
	if err := w.Close(); err != nil {
		t.Errorf("second Close = %v", err)
	}
}

func TestTailAcrossRotation(t *testing.T) {
	dir := t.TempDir()
	w, err := NewRotatingFile(dir, "agent.log", 40, 4)
	if err != nil {
		t.Fatal(err)
	}
	writeLines(t, w, 0, 14)
	_ = w.Close()
	// Lines 0-3 are in .3, 4-7 in .2, 8-11 in .1, 12-13 in agent.log.
	got, err := Tail(dir, "agent.log", 7)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"line 007", "line 008", "line 009", "line 010", "line 011", "line 012", "line 013"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Tail(7) = %v, want %v", got, want)
	}

	all, err := Tail(dir, "agent.log", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 14 || all[0] != "line 000" || all[13] != "line 013" {
		t.Errorf("Tail(100) = %v, want lines 0..13", all)
	}

	none, err := Tail(dir, "agent.log", 0)
	if err != nil || len(none) != 0 {
		t.Errorf("Tail(0) = %v, %v; want empty", none, err)
	}
}

func TestTailPartialLastLine(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent.log"), []byte("a\r\nb\nc"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Tail(dir, "agent.log", 2)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"b", "c"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Tail = %v, want %v", got, want)
	}
	got, _ = Tail(dir, "agent.log", 3)
	if want := []string{"a", "b", "c"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Tail = %v, want %v (CR stripped)", got, want)
	}
}

func TestTailMissing(t *testing.T) {
	_, err := Tail(t.TempDir(), "agent.log", 10)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Tail of no files = %v, want fs.ErrNotExist", err)
	}
}

func TestTailOnlyRotated(t *testing.T) {
	// Between the rename and the create of a rotation only .1 exists.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "agent.log.1"), []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Tail(dir, "agent.log", 5)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"old"}) {
		t.Errorf("Tail = %v", got)
	}
}

func TestHandlerOverRotatingFile(t *testing.T) {
	dir := t.TempDir()
	w, err := NewRotatingFile(dir, "agent.log", 1<<20, 2)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(w, slog.LevelInfo, 16)
	slog.New(h).Info("hello", "k", "v")
	h.Close()
	_ = w.Close()
	lines, err := Tail(dir, "agent.log", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || !strings.Contains(lines[0], `msg=hello k=v`) {
		t.Errorf("Tail = %v", lines)
	}
}
