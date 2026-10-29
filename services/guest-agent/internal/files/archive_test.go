//go:build !windows

package files

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// tarEntry is one entry of a test archive.
type tarEntry struct {
	name string
	typ  byte
	body []byte
	link string
	mode int64
}

// makeTar builds an uncompressed tar of entries.
func makeTar(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		hdr := &tar.Header{Name: e.name, Typeflag: e.typ, Linkname: e.link, Mode: mode, Size: int64(len(e.body)), ModTime: time.Unix(1700000000, 0), Format: tar.FormatPAX}
		if e.typ != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			if _, err := tw.Write(e.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// node describes one path of a tree for comparison.
type node struct {
	typ    fs.FileMode
	perm   fs.FileMode
	sum    [32]byte
	target string
	mtime  int64
}

// snapshot describes every path under root (root excluded).
func snapshot(t *testing.T, root string) map[string]node {
	t.Helper()
	out := map[string]node{}
	err := filepath.WalkDir(root, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		n := node{typ: fi.Mode().Type(), perm: fi.Mode() & (fs.ModePerm | fs.ModeSticky)}
		switch {
		case fi.Mode().IsRegular():
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			n.sum = sha256.Sum256(b)
			n.mtime = fi.ModTime().Unix()
		case fi.Mode()&fs.ModeSymlink != 0:
			n.target, _ = os.Readlink(p)
			n.perm = 0
		}
		out[filepath.ToSlash(rel)] = n
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestArchiveRoundTrip(t *testing.T) {
	for _, format := range []string{"tar", "tar.gz"} {
		t.Run(format, func(t *testing.T) {
			h := newHarness(t)
			src := h.path("src")
			h.writeFile("src/a/b/file.txt", []byte("nested"), 0o644)
			h.writeFile("src/big.bin", randomBytes(3<<20), 0o600)
			h.writeFile("src/run.sh", []byte("#!/bin/sh\n"), 0o755)
			h.writeFile("src/priv/secret", []byte("s"), 0o640)
			if err := os.Chmod(filepath.Join(src, "priv"), 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("a/b/file.txt", filepath.Join(src, "link")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("/nonexistent/target", filepath.Join(src, "dangling")); err != nil {
				t.Fatal(err)
			}
			if err := os.Link(filepath.Join(src, "a/b/file.txt"), filepath.Join(src, "hard")); err != nil {
				t.Fatal(err)
			}
			old := time.Unix(1600000000, 0)
			if err := os.Chtimes(filepath.Join(src, "big.bin"), old, old); err != nil {
				t.Fatal(err)
			}
			// FIFOs are skipped.
			if err := syscall.Mkfifo(filepath.Join(src, "fifo"), 0o644); err != nil {
				t.Fatal(err)
			}
			want := snapshot(t, src)
			delete(want, "fifo")

			res := h.do(http.MethodGet, "/files/archive", q("path", src, "format", format), nil, nil)
			archive := wantStatus(t, res, http.StatusOK)
			wantType := "application/x-tar"
			if format == "tar.gz" {
				wantType = "application/gzip"
			}
			if res.Header.Get("Content-Type") != wantType || res.Header.Get("Content-Encoding") != "" {
				t.Fatalf("headers %v", res.Header)
			}
			names := tarNames(t, archive, format == "tar.gz")
			if slices.Contains(names, "fifo") || slices.ContainsFunc(names, func(n string) bool { return strings.HasPrefix(n, "/") || n == "." || n == "./" }) {
				t.Fatalf("archive names %v", names)
			}

			dst := h.path("dst", "nested")
			res = h.do(http.MethodPut, "/files/archive", q("path", dst, "format", format), bytes.NewReader(archive), nil)
			body := wantStatus(t, res, http.StatusOK)
			var out struct {
				Path    string `json:"path"`
				Entries int    `json:"entries"`
				Size    int64  `json:"size"`
			}
			if err := json.Unmarshal(body, &out); err != nil {
				t.Fatal(err)
			}
			if out.Path != dst || out.Entries != len(want) || out.Size != 3<<20+6+6+10+1 {
				t.Fatalf("response %s (want %d entries)", body, len(want))
			}
			got := snapshot(t, dst)
			for k, w := range want {
				g, ok := got[k]
				if !ok {
					t.Errorf("%s missing", k)
					continue
				}
				if g != w {
					t.Errorf("%s = %+v, want %+v", k, g, w)
				}
			}
			for k := range got {
				if _, ok := want[k]; !ok {
					t.Errorf("unexpected %s", k)
				}
			}
			// Hardlinks are archived as separate files.
			a, _ := os.Stat(filepath.Join(dst, "a/b/file.txt"))
			b, _ := os.Stat(filepath.Join(dst, "hard"))
			if os.SameFile(a, b) {
				t.Error("hardlink was restored as a link; GET writes hardlinks as files")
			}

			// A repeat with overwrite=true gives the same result.
			res = h.do(http.MethodPut, "/files/archive", q("path", dst, "format", format), bytes.NewReader(archive), nil)
			wantStatus(t, res, http.StatusOK)
			if again := snapshot(t, dst); len(again) != len(got) {
				t.Fatalf("repeat changed the tree: %d vs %d entries", len(again), len(got))
			}
			// overwrite=false refuses an existing file.
			res = h.do(http.MethodPut, "/files/archive", q("path", dst, "format", format, "overwrite", "false"), bytes.NewReader(archive), nil)
			wantError(t, res, http.StatusConflict, errs.AlreadyExists)
		})
	}
}

// tarNames lists the entry names of an archive.
func tarNames(t *testing.T, data []byte, gz bool) []string {
	t.Helper()
	var r io.Reader = bytes.NewReader(data)
	if gz {
		zr, err := gzip.NewReader(r)
		if err != nil {
			t.Fatal(err)
		}
		r = zr
	}
	tr := tar.NewReader(r)
	var names []string
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return names
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Format != tar.FormatPAX && hdr.Format != tar.FormatUSTAR {
			t.Fatalf("%s: format %v", hdr.Name, hdr.Format)
		}
		names = append(names, hdr.Name)
	}
}

func TestArchiveGetErrors(t *testing.T) {
	h := newHarness(t)
	f := h.writeFile("f", []byte("x"), 0o644)
	res := h.do(http.MethodGet, "/files/archive", q("path", f), nil, nil)
	wantError(t, res, http.StatusBadRequest, errs.NotDirectory)
	res = h.do(http.MethodGet, "/files/archive", q("path", h.path("missing")), nil, nil)
	wantError(t, res, http.StatusNotFound, errs.PathNotFound)
	res = h.do(http.MethodGet, "/files/archive", q("path", h.root, "format", "zip"), nil, nil)
	wantError(t, res, http.StatusBadRequest, errs.InvalidArgument)
}

func TestArchiveHostile(t *testing.T) {
	ok := tarEntry{name: "ok.txt", typ: tar.TypeReg, body: []byte("ok")}
	tests := []struct {
		name    string
		entries func(outside string) []tarEntry
		written int
	}{
		{"dotdot", func(string) []tarEntry { return []tarEntry{{name: "../x", typ: tar.TypeReg, body: []byte("x")}} }, 0},
		{"dotdot inside", func(string) []tarEntry {
			return []tarEntry{ok, {name: "a/../../x", typ: tar.TypeReg, body: []byte("x")}}
		}, 1},
		{"absolute", func(string) []tarEntry {
			return []tarEntry{{name: "/etc/sbx-hostile-x", typ: tar.TypeReg, body: []byte("x")}}
		}, 0},
		{"symlink to root", func(string) []tarEntry {
			return []tarEntry{{name: "l", typ: tar.TypeSymlink, link: "/"}, {name: "l/sbx-hostile-x", typ: tar.TypeReg, body: []byte("x")}}
		}, 1},
		{"symlink outside", func(outside string) []tarEntry {
			return []tarEntry{{name: "l", typ: tar.TypeSymlink, link: outside}, {name: "l/x", typ: tar.TypeReg, body: []byte("x")}}
		}, 1},
		{"symlink then dir", func(outside string) []tarEntry {
			return []tarEntry{{name: "l", typ: tar.TypeSymlink, link: outside}, {name: "l/d/", typ: tar.TypeDir, mode: 0o755}}
		}, 1},
		{"pre-existing symlink", func(string) []tarEntry { return []tarEntry{{name: "t/x", typ: tar.TypeReg, body: []byte("x")}} }, 0},
		{"pre-existing symlink link", func(string) []tarEntry {
			return []tarEntry{ok, {name: "t/y", typ: tar.TypeLink, link: "ok.txt"}}
		}, 1},
		{"char device", func(string) []tarEntry { return []tarEntry{{name: "dev", typ: tar.TypeChar}} }, 0},
		{"block device", func(string) []tarEntry { return []tarEntry{{name: "blk", typ: tar.TypeBlock}} }, 0},
		{"fifo", func(string) []tarEntry { return []tarEntry{ok, {name: "fifo", typ: tar.TypeFifo}} }, 1},
		{"hardlink outside", func(string) []tarEntry { return []tarEntry{{name: "h", typ: tar.TypeLink, link: "../outside/f"}} }, 0},
		{"hardlink not in archive", func(string) []tarEntry { return []tarEntry{{name: "h", typ: tar.TypeLink, link: "pre"}} }, 0},
		{"hardlink absolute", func(outside string) []tarEntry {
			return []tarEntry{{name: "h", typ: tar.TypeLink, link: filepath.Join(outside, "f")}}
		}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			outside := h.path("outside")
			h.writeFile("outside/f", []byte("keep"), 0o644)
			dst := h.path("dst")
			h.writeFile("dst/pre", []byte("pre"), 0o644)
			if err := os.Symlink(outside, filepath.Join(dst, "t")); err != nil {
				t.Fatal(err)
			}
			before := snapshot(t, outside)
			res := h.do(http.MethodPut, "/files/archive", q("path", dst), bytes.NewReader(makeTar(t, tt.entries(outside)...)), nil)
			e := wantError(t, res, http.StatusBadRequest, errs.InvalidPath)
			if e.EntriesWritten == nil || *e.EntriesWritten != tt.written {
				t.Fatalf("entries_written = %v, want %d", e.EntriesWritten, tt.written)
			}
			after := snapshot(t, outside)
			if len(after) != len(before) || after["f"] != before["f"] {
				t.Fatalf("outside changed: %v -> %v", before, after)
			}
			if _, err := os.Lstat("/sbx-hostile-x"); err == nil {
				t.Fatal("/sbx-hostile-x written")
			}
			if _, err := os.Lstat("/etc/sbx-hostile-x"); err == nil {
				t.Fatal("/etc/sbx-hostile-x written")
			}
		})
	}
}

func TestArchiveTooManyEntries(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.ArchiveMaxEntries = 10
		o.ArchiveMaxBytes = 100
		o.ArchiveMaxPath = 32
	})
	var entries []tarEntry
	for i := range 11 {
		entries = append(entries, tarEntry{name: "f" + itoa(i), typ: tar.TypeReg, body: []byte("x")})
	}
	res := h.do(http.MethodPut, "/files/archive", q("path", h.path("d1")), bytes.NewReader(makeTar(t, entries...)), nil)
	e := wantError(t, res, http.StatusRequestEntityTooLarge, errs.PayloadTooLarge)
	if e.EntriesWritten == nil || *e.EntriesWritten != 10 {
		t.Fatalf("entries_written = %v", e.EntriesWritten)
	}
	res = h.do(http.MethodPut, "/files/archive", q("path", h.path("d2")), bytes.NewReader(makeTar(t, entries[:10]...)), nil)
	wantStatus(t, res, http.StatusOK)

	res = h.do(http.MethodPut, "/files/archive", q("path", h.path("d3")),
		bytes.NewReader(makeTar(t, tarEntry{name: "big", typ: tar.TypeReg, body: randomBytes(101)})), nil)
	wantError(t, res, http.StatusRequestEntityTooLarge, errs.PayloadTooLarge)
	res = h.do(http.MethodPut, "/files/archive", q("path", h.path("d4")),
		bytes.NewReader(makeTar(t, tarEntry{name: strings.Repeat("n", 33), typ: tar.TypeReg})), nil)
	wantError(t, res, http.StatusRequestEntityTooLarge, errs.PayloadTooLarge)

	// make_parents=false needs an existing directory.
	res = h.do(http.MethodPut, "/files/archive", q("path", h.path("nope", "x"), "make_parents", "false"),
		bytes.NewReader(makeTar(t, entries[:1]...)), nil)
	wantError(t, res, http.StatusNotFound, errs.PathNotFound)
	// A corrupt stream is an invalid argument.
	res = h.do(http.MethodPut, "/files/archive", q("path", h.path("d5"), "format", "tar.gz"), strings.NewReader("not gzip"), nil)
	wantError(t, res, http.StatusBadRequest, errs.InvalidArgument)
}

func TestArchivePutModesAndOwner(t *testing.T) {
	h := newHarness(t)
	data := makeTar(t,
		tarEntry{name: "d/", typ: tar.TypeDir, mode: 0o2750},
		tarEntry{name: "d/suid", typ: tar.TypeReg, body: []byte("x"), mode: 0o4755},
		tarEntry{name: "implicit/parent/f", typ: tar.TypeReg, body: []byte("y"), mode: 0o600},
		tarEntry{name: "./dot", typ: tar.TypeReg, body: []byte("z")},
	)
	dst := h.path("m")
	res := h.do(http.MethodPut, "/files/archive", q("path", dst), bytes.NewReader(data), nil)
	wantStatus(t, res, http.StatusOK)
	st, err := os.Stat(filepath.Join(dst, "d", "suid"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode()&(fs.ModeSetuid|fs.ModeSetgid) != 0 || st.Mode().Perm() != 0o755 {
		t.Fatalf("suid file mode %v", st.Mode())
	}
	if st.ModTime().Unix() != 1700000000 {
		t.Fatalf("mtime %v", st.ModTime())
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && (sys.Uid != h.user.UID || sys.Gid != h.user.GID) {
		t.Fatalf("owner %d:%d, want %d:%d", sys.Uid, sys.Gid, h.user.UID, h.user.GID)
	}
	dt, _ := os.Stat(filepath.Join(dst, "d"))
	if dt.Mode()&fs.ModeSetgid != 0 || dt.Mode().Perm() != 0o750 || dt.ModTime().Unix() != 1700000000 {
		t.Fatalf("dir mode %v mtime %v", dt.Mode(), dt.ModTime())
	}
	if _, err := os.Stat(filepath.Join(dst, "implicit", "parent", "f")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "dot")); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveSymlinkedRoot(t *testing.T) {
	h := newHarness(t)
	h.writeFile("real/a/f.txt", []byte("f"), 0o644)
	h.writeFile("real/g.txt", []byte("g"), 0o600)
	link := h.path("link")
	if err := os.Symlink(h.path("real"), link); err != nil {
		t.Fatal(err)
	}
	res := h.do(http.MethodGet, "/files/archive", q("path", link), nil, nil)
	archive := wantStatus(t, res, http.StatusOK)
	names := tarNames(t, archive, false)
	slices.Sort(names)
	if !slices.Equal(names, []string{"a/", "a/f.txt", "g.txt"}) {
		t.Fatalf("names = %v", names)
	}
	dst := h.path("dst")
	res = h.do(http.MethodPut, "/files/archive", q("path", dst), bytes.NewReader(archive), nil)
	wantStatus(t, res, http.StatusOK)
	want, got := snapshot(t, h.path("real")), snapshot(t, dst)
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for k, w := range want {
		if got[k] != w {
			t.Fatalf("%s = %+v, want %+v", k, got[k], w)
		}
	}
}

func TestArchivePutGlobalHeader(t *testing.T) {
	h := newHarness(t)
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	// git archive starts with a pax global header carrying the commit id.
	if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeXGlobalHeader, Name: "pax_global_header", PAXRecords: map[string]string{"comment": "0123456789abcdef"}}); err != nil {
		t.Fatal(err)
	}
	if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: "repo/README", Mode: 0o644, Size: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	dst := h.path("g")
	res := h.do(http.MethodPut, "/files/archive", q("path", dst), bytes.NewReader(buf.Bytes()), nil)
	var out struct{ Entries int }
	if err := json.Unmarshal(wantStatus(t, res, http.StatusOK), &out); err != nil {
		t.Fatal(err)
	}
	if out.Entries != 1 {
		t.Fatalf("entries = %d, want 1", out.Entries)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "repo", "README")); err != nil || string(b) != "hi" {
		t.Fatalf("README = %q, %v", b, err)
	}
	if _, err := os.Lstat(filepath.Join(dst, "pax_global_header")); !os.IsNotExist(err) {
		t.Fatalf("global header written as a file: %v", err)
	}

	// The global header counts toward the entry limit.
	h2 := newHarness(t, func(o *Options) { o.ArchiveMaxEntries = 1 })
	res = h2.do(http.MethodPut, "/files/archive", q("path", h2.path("g")), bytes.NewReader(buf.Bytes()), nil)
	wantError(t, res, http.StatusRequestEntityTooLarge, errs.PayloadTooLarge)
}

func TestArchiveGetAbortsMidStream(t *testing.T) {
	h := newHarness(t)
	h.writeFile("src/a.bin", randomBytes(64<<10), 0o644)
	big := h.writeFile("src/b.bin", randomBytes(1<<20), 0o644)
	h.svc.testHookAfterHeader = func(name string) {
		if name == "b.bin" {
			// The file shrinks after its header promised 1 MiB.
			_ = os.Truncate(big, 1000)
		}
	}
	req, err := http.NewRequestWithContext(h.ctx(), http.MethodGet, h.srv.URL+"/files/archive?"+q("path", h.path("src")).Encode(), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := h.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	data, err := io.ReadAll(res.Body)
	if err == nil {
		t.Fatalf("the response ended cleanly (%d bytes); want an aborted stream", len(data))
	}
	end := make([]byte, 1024)
	if len(data) >= len(end) && bytes.Equal(data[len(data)-len(end):], end) {
		t.Fatal("the aborted stream ends with tar end blocks")
	}
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		_, err := tr.Next()
		if err == nil {
			_, err = io.Copy(io.Discard, tr)
		}
		if errors.Is(err, io.EOF) {
			t.Fatal("the partial archive parses as complete")
		}
		if err != nil {
			break
		}
	}
}
