package desktop

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestOwnUserDesktopParents(t *testing.T) {
	root := filepath.Join("home", "user", ".local")
	var calls [][]string
	err := ownUserDesktopParents(t.Context(), filepath.Join(root, "state", "sbx-sunshine"), func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		return nil, nil
	})
	want := [][]string{{"chown", "user:user", filepath.Join(root, "state")}, {"chown", "user:user", root}}
	if err != nil || !reflect.DeepEqual(calls, want) {
		t.Fatal(calls, err)
	}
	failure := errors.New("denied")
	err = ownUserDesktopParents(t.Context(), root, func(context.Context, string, ...string) ([]byte, error) { return nil, failure })
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
}
