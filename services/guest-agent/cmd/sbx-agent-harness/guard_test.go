package main

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func testGuard() homeGuard {
	return homeGuard{home: "/Users/dev", scratch: "/tmp/sbxa1/work"}
}

func TestMapPath(t *testing.T) {
	g := testGuard()
	for _, c := range []struct{ in, want string }{
		{"", ""},
		{"~", "/tmp/sbxa1/work"},
		{"~/x", "/tmp/sbxa1/work/x"},
		{"~/a/../b", "/tmp/sbxa1/work/b"},
		{"rel/x", "/tmp/sbxa1/work/rel/x"},
		{"~foo", "/tmp/sbxa1/work/~foo"},
		{"/Users/dev", "/tmp/sbxa1/work"},
		{"/Users/dev/x", "/tmp/sbxa1/work/x"},
		{"/tmp/../Users/dev/x", "/tmp/sbxa1/work/x"},
		{"/Users/devil/x", "/Users/devil/x"},
		{"/etc/hosts", "/etc/hosts"},
	} {
		got, err := g.mapPath(c.in)
		if err != nil || got != c.want {
			t.Errorf("mapPath(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
}

func TestMapPathRefusesLeavingScratch(t *testing.T) {
	g := testGuard()
	for _, in := range []string{
		"../../../../Users/dev/x",
		"~/../../../Users/dev/x",
		"..",
		"~/..",
		"a/../../x",
	} {
		if got, err := g.mapPath(in); err == nil {
			t.Errorf("mapPath(%q) = %q, want an error", in, got)
		}
	}
}

func TestMapPathCaseOnDarwin(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("case-insensitive only on darwin")
	}
	got, err := testGuard().mapPath("/users/DEV/x")
	if err != nil || got != "/tmp/sbxa1/work/x" {
		t.Errorf("mapPath = %q, %v", got, err)
	}
}

func TestRewriteCommit(t *testing.T) {
	g := testGuard()
	out, err := g.rewriteCommit([]byte(`{"path":"~/u.bin","sha256":"ab","mode":384}`))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	if m["path"] != "/tmp/sbxa1/work/u.bin" || m["sha256"] != "ab" || m["mode"] != float64(384) {
		t.Errorf("rewritten = %s", out)
	}
	if out, err := g.rewriteCommit([]byte(`{"sha256":"ab"}`)); err != nil || !strings.Contains(string(out), `"sha256":"ab"`) {
		t.Errorf("without path = %s, %v", out, err)
	}
}

func TestRewriteCommitRefuses(t *testing.T) {
	g := testGuard()
	for _, body := range []string{
		``,
		`not json`,
		`[1]`,
		`"path"`,
		`{"path":"x"} {"path":"y"}`,
		`{"path":"x"}garbage`,
		`{"Path":"/Users/dev/x"}`,
		`{"PATH":"x"}`,
		`{"path":"x","path":"y"}`,
		`{"path":1}`,
		`{"path":"../../../../Users/dev/x"}`,
		`{"path":"x"`,
	} {
		if out, err := g.rewriteCommit([]byte(body)); err == nil {
			t.Errorf("rewriteCommit(%s) = %s, want an error", body, out)
		}
	}
}
