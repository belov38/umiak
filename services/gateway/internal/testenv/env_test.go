package testenv_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/pgtest"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

// dialer returns a DialContext that opens a tunnel stream to port of the
// machine on instance i.
func dialer(i *testenv.Inst, m *testenv.Machine, port uint16) func(ctx context.Context, _, _ string) (net.Conn, error) {
	return func(ctx context.Context, _, _ string) (net.Conn, error) {
		mc, ok := i.Tunnel().Machine(m.ID)
		if !ok {
			return nil, errors.New("machine not local")
		}
		return mc.DialTCP(ctx, port)
	}
}

func getBody(t *testing.T, c *http.Client, url string) string {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.Proto + " " + string(b)
}

func TestMachineApps(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	inst := env.StartInstance(nil)
	m := env.NewMachine()
	if m.Owner() != inst {
		t.Fatal("machine is not served by the instance")
	}
	hello := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "hi "+r.Host) })
	m.ServeHTTP(8080, hello)
	m.ServeH2C(8081, hello)
	m.ServeTCP(7000, testenv.Echo)
	m.Blackhole(7001)

	t1 := &http.Transport{DialContext: dialer(inst, m, 8080)}
	t.Cleanup(t1.CloseIdleConnections)
	h1 := &http.Client{Transport: t1}
	if got := getBody(t, h1, "http://app.local/"); got != "HTTP/1.1 hi app.local" {
		t.Fatalf("http app = %q", got)
	}
	var p http.Protocols
	p.SetUnencryptedHTTP2(true)
	t2 := &http.Transport{DialContext: dialer(inst, m, 8081), Protocols: &p}
	t.Cleanup(t2.CloseIdleConnections)
	h2c := &http.Client{Transport: t2}
	if got := getBody(t, h2c, "http://app.local/"); got != "HTTP/2.0 hi app.local" {
		t.Fatalf("h2c app = %q", got)
	}

	ctx := context.Background()
	mc, _ := inst.Tunnel().Machine(m.ID)
	c, err := mc.DialTCP(ctx, 7000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo = %q, %v", buf, err)
	}
	_ = c.Close()

	// No app: a real ECONNREFUSED inside the machine.
	var de *transport.DialError
	if _, err := mc.DialTCP(ctx, 9999); !errors.As(err, &de) || de.Status != http.StatusBadGateway || de.Reason != "refused" {
		t.Fatalf("unbound port: err = %v, want 502 refused", err)
	}

	// Blackhole: the dial hangs until the caller gives up.
	bctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := mc.DialTCP(bctx, 7001); err == nil {
		t.Fatal("blackholed dial succeeded")
	}
	if d := time.Since(start); d < 250*time.Millisecond {
		t.Fatalf("blackholed dial returned after %s", d)
	}
}

func TestMachineRestartAndMove(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	s1, err := env.Store.Session(context.Background(), m.ID)
	if err != nil {
		t.Fatal(err)
	}

	m.Restart()
	s2, err := env.Store.Session(context.Background(), m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Epoch <= s1.Epoch || s2.AgentInstanceID == s1.AgentInstanceID {
		t.Fatalf("after restart: epoch %d -> %d, agent %s -> %s", s1.Epoch, s2.Epoch, s1.AgentInstanceID, s2.AgentInstanceID)
	}

	// A graceful stop of A moves the machine to B.
	b := env.StartInstance(nil)
	env.StopInstance(a, true)
	m.WaitConnected()
	if m.Owner() != b {
		t.Fatalf("owner after drain = %v, want %s", m.Owner(), b.Name)
	}
	if len(env.Instances()) != 1 {
		t.Fatalf("instances = %d, want 1", len(env.Instances()))
	}
}
