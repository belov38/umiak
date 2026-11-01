package process

import (
	"errors"
	"testing"
)

func TestLookupUserSystemAlias(t *testing.T) {
	for _, name := range []string{"root", "SYSTEM", "system"} {
		u, err := LookupUser(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if u.Windows == nil || !u.Windows.System || u.Name != "SYSTEM" ||
			u.Home != systemProfile || u.Shell != pwshPath {
			t.Fatalf("%s: %+v %+v", name, u, u.Windows)
		}
	}
	for _, name := range []string{"", "nobody-umiak", "Administrator"} {
		if _, err := LookupUser(name); !errors.Is(err, ErrUserNotFound) {
			t.Errorf("%q: %v, want ErrUserNotFound", name, err)
		}
	}
}

// The template account; skipped where it does not exist.
func TestLookupUserDefault(t *testing.T) {
	u, err := LookupUser("user")
	if errors.Is(err, ErrUserNotFound) {
		t.Skip("no account user here")
	}
	if err != nil {
		t.Fatal(err)
	}
	if u.Windows == nil || u.Windows.System || u.Windows.Account != "user" || u.Home == "" || u.Shell != pwshPath {
		t.Fatalf("%+v %+v", u, u.Windows)
	}
}
