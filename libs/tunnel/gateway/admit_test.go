package gateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/belov38/umiak/libs/tunnel/transport"
)

// The secret is dropped once admission checked it: nothing that outlives
// Admit (the admission, the session) can print it, whatever fmt does with
// their unexported Hello fields.
func TestAdmittedHelloKeepsNoSecret(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", nil)
	id, bs := e.machine()
	leak := strings.Trim(fmt.Sprint([]int{int(bs[0]), int(bs[1]), int(bs[2]), int(bs[3])}), "[]")

	ident := defaultIdentity()
	adm, err := gw.Admitter().Admit(context.Background(), transport.Hello{
		MachineID: id, BootID: ident.BootID, AgentInstanceID: ident.InstanceID, Vmgenid: ident.Vmgenid,
		AgentVersion: ident.Version, Scheme: transport.AuthBootstrap, Secret: bs,
	})
	if err != nil {
		t.Fatal(err)
	}
	a := adm.(*admission)
	if a.hello.Secret != nil {
		t.Errorf("admission keeps the secret")
	}
	if s := fmt.Sprintf("%+v", *a); strings.Contains(s, leak) {
		t.Errorf("admission prints the secret: %s", s)
	}
	adm.Abort(errors.New("test"))

	e.startAgent(agentConfig(e, id, bs, ident)).waitConnected()
	s := localSession(t, gw, id)
	if s.hello.Secret != nil {
		t.Errorf("session keeps the secret")
	}
	if out := fmt.Sprintf("%+v", s.hello) + fmt.Sprintf("%+v", struct{ h transport.Hello }{s.hello}); strings.Contains(out, leak) {
		t.Errorf("session hello prints the secret: %s", out)
	}
}
