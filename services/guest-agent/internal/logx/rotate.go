package logx

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// rotatingFile is an io.WriteCloser over dir/name that keeps at most keep
// files: name (the active one) and name.1 .. name.<keep-1>, newest first.
// A write that would grow the active file past maxBytes rotates it first, so
// a record handed to one Write is never split between files.
type rotatingFile struct {
	mu       sync.Mutex
	dir      string
	name     string
	maxBytes int64
	keep     int
	f        *os.File
	size     int64
	closed   bool
}

// NewRotatingFile opens dir/name for appending, creating dir if needed. The
// size of an existing file counts toward maxBytes. keep is the total number
// of files including the active one; values below 1 mean 1 (the active file
// is truncated on rotation).
func NewRotatingFile(dir, name string, maxBytes int64, keep int) (io.WriteCloser, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("logx: maxBytes %d is not positive", maxBytes)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("logx: %w", err)
	}
	r := &rotatingFile{dir: dir, name: name, maxBytes: maxBytes, keep: max(keep, 1)}
	if err := r.open(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *rotatingFile) path(i int) string {
	if i == 0 {
		return filepath.Join(r.dir, r.name)
	}
	return filepath.Join(r.dir, r.name+"."+strconv.Itoa(i))
}

func (r *rotatingFile) open() error {
	f, err := os.OpenFile(r.path(0), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("logx: %w", err)
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("logx: %w", err)
	}
	r.f, r.size = f, fi.Size()
	return nil
}

// Write implements io.Writer.
func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return 0, fs.ErrClosed
	}
	if r.f == nil {
		// A previous rotation could not reopen the file; try again.
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	if r.size > 0 && r.size+int64(len(p)) > r.maxBytes {
		if err := r.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

// rotate shifts name.i to name.i+1, dropping the oldest, and starts a new
// active file. If a rename fails (on Windows a reader may hold a file open
// without FILE_SHARE_DELETE) the active file keeps growing and the next
// attempt waits for another maxBytes, so a held file does not make every
// write drop a generation.
func (r *rotatingFile) rotate() error {
	if err := r.f.Close(); err != nil {
		r.f = nil
		return fmt.Errorf("logx: %w", err)
	}
	r.f = nil
	var err error
	if r.keep == 1 {
		err = os.Remove(r.path(0))
	} else {
		_ = os.Remove(r.path(r.keep - 1))
		for i := r.keep - 2; i >= 0 && err == nil; i-- {
			if err = os.Rename(r.path(i), r.path(i+1)); errors.Is(err, fs.ErrNotExist) {
				err = nil
			}
		}
	}
	if oerr := r.open(); oerr != nil {
		return oerr
	}
	if err != nil {
		r.size = 0
	}
	return nil
}

// Close implements io.Closer. Writes after Close fail with fs.ErrClosed.
func (r *rotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

// Tail returns the last n lines of dir/name and its rotated files
// (name.1, name.2, ...), oldest first, without line terminators. It fails
// with an error wrapping fs.ErrNotExist when none of the files exist.
func Tail(dir, name string, n int) ([]string, error) {
	var out []string
	found := false
	for i := 0; len(out) < n || !found; i++ {
		p := filepath.Join(dir, name)
		if i > 0 {
			p += "." + strconv.Itoa(i)
		}
		lines, err := tailFile(p, n-len(out))
		if errors.Is(err, fs.ErrNotExist) {
			// The active file is briefly missing during a rotation.
			if i == 0 {
				continue
			}
			break
		}
		if err != nil {
			return nil, fmt.Errorf("logx: %w", err)
		}
		found = true
		out = append(lines, out...)
	}
	if !found {
		return nil, fmt.Errorf("logx: no log %s in %s: %w", name, dir, fs.ErrNotExist)
	}
	return out, nil
}

// tailFile returns the last n lines of the file at p.
func tailFile(p string, n int) ([]string, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	if n <= 0 {
		return nil, nil
	}
	ring := make([]string, 0, n)
	start := 0
	br := bufio.NewReader(f)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
			if len(ring) < n {
				ring = append(ring, line)
			} else {
				ring[start] = line
				start = (start + 1) % n
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return append(ring[start:], ring[:start]...), nil
}
