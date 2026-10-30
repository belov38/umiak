//go:build !windows

package process

import (
	"errors"
	"os/user"
	"strconv"
	"testing"
)

func TestLookupUser(t *testing.T) {
	cu, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	u, err := LookupUser(cu.Username)
	if err != nil {
		t.Fatal(err)
	}
	if u.Name != cu.Username || strconv.FormatUint(uint64(u.UID), 10) != cu.Uid ||
		strconv.FormatUint(uint64(u.GID), 10) != cu.Gid || u.Home != cu.HomeDir {
		t.Fatalf("user %+v, current %+v", u, cu)
	}
	if u.Shell == "" {
		t.Fatal("empty shell")
	}

	if _, err := LookupUser("no-such-user-sbx-test"); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("unknown user: %v", err)
	}
	if _, err := LookupUser(""); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("empty name: %v", err)
	}
}

func TestPasswdShell(t *testing.T) {
	passwd := "# comment\nroot:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/usr/bin/zsh\nbroken\n"
	tests := []struct{ name, want string }{
		{"root", "/bin/bash"},
		{"user", "/usr/bin/zsh"},
		{"nobody", ""},
	}
	for _, tt := range tests {
		if got := passwdShell([]byte(passwd), tt.name); got != tt.want {
			t.Errorf("passwdShell(%q) = %q, want %q", tt.name, got, tt.want)
		}
	}
}
