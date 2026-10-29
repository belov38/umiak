package sshgw_test

import (
	"context"
	"io"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/server"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/sshgw"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/testenv/sshdtest"
)

// openCat starts "cat" on a new session channel (it runs until stdin
// closes) and returns its stderr.
func openCat(t *testing.T, c *ssh.Client) io.Reader {
	t.Helper()
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := s.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stderr, err := s.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start("cat"); err != nil {
		t.Fatal(err)
	}
	return stderr
}

// openShell starts an interactive shell (pty) and returns its stderr.
func openShell(t *testing.T, c *ssh.Client) io.Reader {
	t.Helper()
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.RequestPty("xterm", 24, 80, ssh.TerminalModes{ssh.ECHO: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stderr, err := s.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	return stderr
}

// readAllWithin reads r to EOF and fails after d.
func readAllWithin(t *testing.T, r io.Reader, d time.Duration) string {
	t.Helper()
	type res struct {
		b   []byte
		err error
	}
	ch := make(chan res, 1)
	go func() {
		b, err := io.ReadAll(r)
		ch <- res{b, err}
	}()
	select {
	case r := <-ch:
		return string(r.b)
	case <-time.After(d):
		t.Fatalf("no EOF within %s", d)
		return ""
	}
}

// readWithin reads len(want) bytes of r and fails when they differ or do
// not arrive within d.
func readWithin(t *testing.T, r io.Reader, want string, d time.Duration) {
	t.Helper()
	type res struct {
		b   []byte
		err error
	}
	ch := make(chan res, 1)
	go func() {
		b := make([]byte, len(want))
		_, err := io.ReadFull(r, b)
		ch <- res{b, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil || string(r.b) != want {
			t.Fatalf("read %q, %v; want %q", r.b, r.err, want)
		}
	case <-time.After(d):
		t.Fatalf("%q not read within %s", want, d)
	}
}

func TestRevokeE2E(t *testing.T) {
	f, c, _ := userClient(t, nil)
	other := newSigner(t)
	f.allowKey(other.PublicKey(), f.userAuth("usr_2"))
	c2 := f.mustDial(t, f.slug, ssh.PublicKeys(other))

	stderr := openCat(t, c)
	openCat(t, c2)
	srv := f.inst.SSH()
	eventually(t, "two session channels", func() bool { return sshgw.SessionChannels(srv) == 2 })

	f.env.Notify(server.ChannelSSHRevoke, "user:usr_1")
	if got := readAllWithin(t, stderr, 2*time.Second); got != "sbx: access revoked\r\n" {
		t.Fatalf("stderr %q", got)
	}
	done := make(chan struct{})
	go func() {
		_ = c.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("revoked conn not closed within 2 s")
	}
	if l := f.waitLog(t); l["closeReason"] != "revoked" || l["userId"] != "usr_1" {
		t.Fatalf("log %v", l)
	}
	// usr_2 keeps working.
	if r := run(t, c2, "echo still"); r.stdout != "still\n" {
		t.Fatalf("other user's exec: %v", r)
	}
	if n := srv.Sessions(); n != 1 {
		t.Fatalf("%d sessions, want 1", n)
	}
}

func TestRecheckOnReconnect(t *testing.T) {
	f, c, _ := userClient(t, nil)
	stderr := openCat(t, c)
	srv := f.inst.SSH()
	eventually(t, "one session channel", func() bool { return sshgw.SessionChannels(srv) == 1 })

	f.env.API.ClearSSH() // ssh/authorize now denies
	var killed int
	err := f.env.Pool.QueryRow(context.Background(), `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
		WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'listen %'`).Scan(&killed)
	if err != nil || killed != 1 {
		t.Fatalf("terminate listener: killed=%d err=%v", killed, err)
	}
	if got := readAllWithin(t, stderr, testenv.WaitTimeout); got != "sbx: access revoked\r\n" {
		t.Fatalf("stderr %q", got)
	}
	waitClosed(t, c)
	if l := f.waitLog(t); l["closeReason"] != "revoked" {
		t.Fatalf("log %v", l)
	}
}

// The front B holds the SSH connection; the backend stream runs through
// the tunnel on A. When A drains, B warns and closes at A's deadline.
func TestOwnerDrainE2E(t *testing.T) {
	env := testenv.New(t, testenv.Options{})
	a := env.StartInstance(nil)
	m := env.NewMachine()
	sshd := sshdtest.New(t, env.Keys.UserCA.PublicKey(), loginUser)
	m.ServeSSHD(sshd)
	b := env.StartInstance(nil)
	f := &fixture{env: env, inst: b, m: m, sshd: sshd, slug: "quiet-otter-lamp"}
	key := newSigner(t)
	f.allowKey(key.PublicKey(), f.userAuth("usr_1"))
	c := f.mustDial(t, f.slug, ssh.PublicKeys(key))
	stderr := openShell(t, c)
	eventually(t, "one interactive channel", func() bool { return sshgw.InteractiveChannels(b.SSH()) == 1 })
	if m.Owner() != a {
		t.Fatal("the machine is not on A")
	}

	// A's drain started 1 s ago; the SSH drain deadline is 2 s.
	if _, err := env.Pool.Exec(context.Background(), `UPDATE tunnel.gateway_instances
		SET state = 'draining', drain_started_at = now() - interval '1 second' WHERE id = $1`, a.Name); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	env.Notify(wire.NotifyInstancesChannel, a.Name)
	want := "sbx: gateway restarting, this SSH session will close in 1 min; reconnect to continue\r\n"
	readWithin(t, stderr, want, 5*time.Second)
	waitClosed(t, c)
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("closed after %s, want about 1 s", took)
	}
	if l := f.waitLog(t); l["closeReason"] != "drain" {
		t.Fatalf("log %v", l)
	}
}
