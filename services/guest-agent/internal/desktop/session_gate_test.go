package desktop

import (
	"context"
	"path/filepath"
	"testing"
)

func TestSessionGateRestartsOnlyForNewBootOrIdentity(t *testing.T) {
	var actions []string
	run := func(_ context.Context, _ string, args ...string) ([]byte, error) {
		actions = append(actions, args[0])
		return nil, nil
	}
	g := SessionGate{Marker: filepath.Join(t.TempDir(), "boot"), IdentityBoot: "id:boot1", Run: run}
	for range 2 {
		if e := g.Start(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	g.IdentityBoot = "fork:boot2"
	if e := g.Start(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(actions) != 3 || actions[0] != "restart" || actions[1] != "start" || actions[2] != "restart" {
		t.Fatalf("session lifecycle %v", actions)
	}
}
