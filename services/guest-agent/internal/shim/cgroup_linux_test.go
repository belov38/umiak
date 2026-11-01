//go:build linux

package shim

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOwnCgroup(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
		ok      bool
	}{
		{"v2", "0::/umiak-cmd.slice/umiak-cmd-c1.service\n", "/umiak-cmd.slice/umiak-cmd-c1.service", true},
		{"hybrid", "1:name=systemd:/x\n0::/system.slice/a.service\n", "/system.slice/a.service", true},
		{"root", "0::/\n", "", false},
		{"v1 only", "1:name=systemd:/x\n", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "cgroup")
			if err := os.WriteFile(p, []byte(tt.content), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := ownCgroup(p)
			if (err == nil) != tt.ok || got != tt.want {
				t.Errorf("ownCgroup = %q, %v; want %q, ok %v", got, err, tt.want, tt.ok)
			}
		})
	}
}

func TestCgroupKeyed(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"cgroup.events": "populated 1\nfrozen 0\n",
		"memory.events": "low 0\nhigh 0\nmax 2\noom 1\noom_kill 3\noom_group_kill 0\n",
		"cgroup.kill":   "",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	c := &cgroup{dir: dir, fd: -1}
	if pop, err := c.populated(); err != nil || !pop {
		t.Errorf("populated = %v, %v", pop, err)
	}
	if n, err := c.oomKills(); err != nil || n != 3 {
		t.Errorf("oomKills = %d, %v; want 3 (not oom_group_kill)", n, err)
	}
	if err := c.kill(); err != nil {
		t.Errorf("kill: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "cgroup.kill")); string(b) != "1" {
		t.Errorf("cgroup.kill = %q", b)
	}
}
