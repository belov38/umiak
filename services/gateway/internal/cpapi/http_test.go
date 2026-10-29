package cpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi/cpapitest"
)

const token = "svc-token"

func newPair(t *testing.T) (*cpapitest.Fake, cpapi.Client) {
	t.Helper()
	f := cpapitest.NewFake()
	srv := cpapitest.NewServer(f, token)
	t.Cleanup(srv.Close)
	return f, cpapi.NewHTTPClient(srv.URL, token, srv.Client())
}

func TestHTTPClientLookupRoute(t *testing.T) {
	f, c := newPair(t)
	want := cpapi.Route{
		Label: "quiet-otter-lamp-5173", SandboxID: "sbx_1", Slug: "quiet-otter-lamp", Port: 5173,
		MachineID: "0192abc", SandboxState: "running", Access: "token", TokenHash: "abcd",
		AuthEpoch: 7, Blocked: true, BlockReason: "abuse", HostRewrite: "localhost",
		AppProtocol: "h2c", TeamID: "team_1", Kind: "port",
	}
	f.SetRoute(want)
	got, err := c.LookupRoute(context.Background(), "quiet-otter-lamp-5173")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("route = %+v, want %+v", got, want)
	}
}

func TestHTTPClientRouteWireFormat(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.EscapedPath(), r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		// Null fields, no kind, and a field the client does not know.
		_, _ = w.Write([]byte(`{"label":"foo-80","sandboxId":"sbx_1","slug":"foo","port":80,
			"machineId":null,"sandboxState":"stopped","access":"public","tokenHash":null,
			"authEpoch":3,"blocked":false,"blockReason":null,"hostRewrite":"preserve",
			"appProtocol":"http1","teamId":"team_1","somethingNew":{"a":1}}`))
	}))
	defer srv.Close()
	c := cpapi.NewHTTPClient(srv.URL, token, nil)

	got, err := c.LookupRoute(context.Background(), "foo-80")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/internal/v1/gateway/routes/foo-80" || gotAuth != "Bearer "+token {
		t.Fatalf("path %q auth %q", gotPath, gotAuth)
	}
	if got.MachineID != "" || got.TokenHash != "" || got.BlockReason != "" {
		t.Fatalf("null fields not mapped to empty strings: %+v", got)
	}
	if got.Kind != "port" {
		t.Fatalf("kind = %q, want default port", got.Kind)
	}
	if got.Port != 80 || got.AuthEpoch != 3 || got.TeamID != "team_1" {
		t.Fatalf("route = %+v", got)
	}

	desktop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"label":"foo-desktop","slug":"foo","port":0,"kind":"desktop","sandboxState":"ready"}`))
	}))
	defer desktop.Close()
	got, err = cpapi.NewHTTPClient(desktop.URL, token, nil).LookupRoute(context.Background(), "foo-desktop")
	if err != nil || got.Kind != "desktop" {
		t.Fatalf("desktop route = %+v, %v", got, err)
	}
}

// A 200 answer for another label is never used: caching it under the
// requested label would serve one tenant's route for another's host name.
func TestHTTPClientRejectsRouteForOtherLabel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"label":"other-80","slug":"other","port":80,"sandboxState":"ready","access":"public"}`))
	}))
	defer srv.Close()
	_, err := cpapi.NewHTTPClient(srv.URL, token, nil).LookupRoute(context.Background(), "foo-80")
	if !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestHTTPClientLabelIsPathEscaped(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"route_not_found"}`))
	}))
	defer srv.Close()
	c := cpapi.NewHTTPClient(srv.URL, token, nil)
	_, err := c.LookupRoute(context.Background(), "../../admin/x?y#z")
	if !errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatalf("err = %v", err)
	}
	if want := "/internal/v1/gateway/routes/..%2F..%2Fadmin%2Fx%3Fy%23z"; gotPath != want {
		t.Fatalf("path = %q, want %q", gotPath, want)
	}
}

func TestHTTPClientErrors(t *testing.T) {
	f, c := newPair(t)

	if _, err := c.LookupRoute(context.Background(), "nope-80"); !errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatalf("404: err = %v, want ErrRouteNotFound", err)
	}

	f.SetDown(true)
	if _, err := c.LookupRoute(context.Background(), "nope-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("down: err = %v, want ErrUnavailable", err)
	}
	f.SetDown(false)

	bad := cpapi.NewHTTPClient(serverURL(t, f), "wrong", nil)
	_, err := bad.LookupRoute(context.Background(), "nope-80")
	if !errors.Is(err, cpapi.ErrUnavailable) || errors.Is(err, cpapi.ErrRouteNotFound) {
		t.Fatalf("401: err = %v, want ErrUnavailable", err)
	}
	if _, err := bad.ExchangePortAuthCode(context.Background(), "c", "nope-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("exchange 401: err = %v, want ErrUnavailable", err)
	}
	if _, err := bad.AuthorizeSSH(context.Background(), cpapi.SSHAuthorizeRequest{Sandbox: "x"}); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("ssh 401: err = %v, want ErrUnavailable", err)
	}
}

func serverURL(t *testing.T, f *cpapitest.Fake) string {
	t.Helper()
	srv := cpapitest.NewServer(f, token)
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestHTTPClientStatusMapping(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"403", 403, `{}`, cpapi.ErrUnavailable},
		{"500", 500, `oops`, cpapi.ErrUnavailable},
		{"503", 503, ``, cpapi.ErrUnavailable},
		{"404 without the route code", 404, `<html>nginx</html>`, cpapi.ErrUnavailable},
		{"404 route_not_found", 404, `{"code":"route_not_found"}`, cpapi.ErrRouteNotFound},
		{"200 with junk", 200, `not json`, cpapi.ErrUnavailable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			_, err := cpapi.NewHTTPClient(srv.URL, token, nil).LookupRoute(context.Background(), "foo-80")
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestHTTPClientNoRedirects(t *testing.T) {
	var followed atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		followed.Add(1)
		_, _ = w.Write([]byte(`{"label":"foo-80","sandboxState":"ready"}`))
	}))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/elsewhere", http.StatusFound)
	}))
	defer srv.Close()

	// Even a caller-supplied client that follows redirects must not.
	c := cpapi.NewHTTPClient(srv.URL, token, &http.Client{})
	if _, err := c.LookupRoute(context.Background(), "foo-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if _, err := c.ExchangePortAuthCode(context.Background(), "c", "foo-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("exchange err = %v, want ErrUnavailable", err)
	}
	if followed.Load() != 0 {
		t.Fatal("redirect was followed")
	}
}

func TestHTTPClientBodyCap(t *testing.T) {
	big := strings.Repeat("x", 1<<20)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"label":"foo-80","slug":"` + big + `"}`))
	}))
	defer srv.Close()
	c := cpapi.NewHTTPClient(srv.URL, token, nil)
	if _, err := c.LookupRoute(context.Background(), "foo-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}

	// A body of exactly 64 KiB is still fine.
	const limit = 64 << 10
	pad := strings.Repeat(" ", limit-len(`{"label":"foo-80"}`))
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"label":"foo-80"}` + pad))
	}))
	defer ok.Close()
	if r, err := cpapi.NewHTTPClient(ok.URL, token, nil).LookupRoute(context.Background(), "foo-80"); err != nil || r.Label != "foo-80" {
		t.Fatalf("64 KiB body: %+v, %v", r, err)
	}
}

func TestHTTPClientContextAndTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	c := cpapi.NewHTTPClient(srv.URL, token, &http.Client{Timeout: 100 * time.Millisecond})
	if _, err := c.LookupRoute(context.Background(), "foo-80"); !errors.Is(err, cpapi.ErrUnavailable) {
		t.Fatalf("timeout: err = %v, want ErrUnavailable", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	c = cpapi.NewHTTPClient(srv.URL, token, nil)
	_, err := c.LookupRoute(ctx, "foo-80")
	if !errors.Is(err, cpapi.ErrUnavailable) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ctx deadline: err = %v", err)
	}
}

func TestHTTPClientExchange(t *testing.T) {
	f, c := newPair(t)
	code := f.IssueCode("foo-80", cpapi.PortAuthGrant{UserID: "usr_1", Email: "a@example.com", AuthEpoch: 4})

	if _, err := c.ExchangePortAuthCode(context.Background(), code, "bar-80"); !errors.Is(err, cpapi.ErrInvalidCode) {
		t.Fatalf("wrong label: err = %v, want ErrInvalidCode", err)
	}
	g, err := c.ExchangePortAuthCode(context.Background(), code, "foo-80")
	if err != nil {
		t.Fatal(err)
	}
	want := cpapi.PortAuthGrant{UserID: "usr_1", Email: "a@example.com", Label: "foo-80", AuthEpoch: 4}
	if g != want {
		t.Fatalf("grant = %+v, want %+v", g, want)
	}
	if _, err := c.ExchangePortAuthCode(context.Background(), code, "foo-80"); !errors.Is(err, cpapi.ErrInvalidCode) {
		t.Fatalf("reuse: err = %v, want ErrInvalidCode", err)
	}
	if _, err := c.ExchangePortAuthCode(context.Background(), "garbage", "foo-80"); !errors.Is(err, cpapi.ErrInvalidCode) {
		t.Fatalf("garbage: err = %v, want ErrInvalidCode", err)
	}
	if n := f.Calls("ExchangePortAuthCode"); n != 4 {
		t.Fatalf("calls = %d, want 4", n)
	}
}

func TestHTTPClientExchange400WithoutCodeIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"something_else"}`))
	}))
	defer srv.Close()
	_, err := cpapi.NewHTTPClient(srv.URL, token, nil).ExchangePortAuthCode(context.Background(), "c", "foo-80")
	if !errors.Is(err, cpapi.ErrUnavailable) || errors.Is(err, cpapi.ErrInvalidCode) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestHTTPClientAuthorizeSSH(t *testing.T) {
	f, c := newPair(t)
	f.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool {
		return r.Certificate != nil && r.Certificate.KeyID == "sbx:key:key_1"
	},
		cpapi.SSHAuthorization{
			Allowed: true, Actor: cpapi.SSHActor{Kind: "team_key", APIKeyID: "key_1"},
			SandboxID: "sbx_1", MachineID: "m1", SandboxState: "ready", LoginUser: "ubuntu", TeamID: "team_1",
		})
	f.SetSSH(func(r cpapi.SSHAuthorizeRequest) bool { return r.Fingerprint == "SHA256:abc" },
		cpapi.SSHAuthorization{
			Allowed: true, Actor: cpapi.SSHActor{Kind: "user", UserID: "usr_1", Email: "a@example.com"},
			UserID: "usr_1", Email: "a@example.com", SandboxID: "sbx_1", LoginUser: "dev", TeamID: "team_1",
		})

	validBefore := time.Date(2026, 10, 29, 12, 10, 0, 0, time.UTC)
	got, err := c.AuthorizeSSH(context.Background(), cpapi.SSHAuthorizeRequest{
		Sandbox: "quiet-otter-lamp",
		Certificate: &cpapi.SSHCertInfo{
			KeyID: "sbx:key:key_1", Serial: "42", Principal: "sb_1", ValidBefore: validBefore,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Allowed || got.Actor.Kind != "team_key" || got.Actor.APIKeyID != "key_1" || got.TeamID != "team_1" ||
		got.LoginUser != "ubuntu" || got.MachineID != "m1" {
		t.Fatalf("auth = %+v", got)
	}

	var body map[string]any
	if err := json.Unmarshal(f.LastSSHBody(), &body); err != nil {
		t.Fatalf("last body: %v", err)
	}
	cert, _ := body["certificate"].(map[string]any)
	if body["sandbox"] != "quiet-otter-lamp" || cert["keyId"] != "sbx:key:key_1" || cert["serial"] != "42" ||
		cert["principal"] != "sb_1" || cert["validBefore"] != "2026-10-29T12:10:00Z" {
		t.Fatalf("request body = %s", f.LastSSHBody())
	}
	if _, has := body["publicKey"]; has {
		t.Fatalf("empty publicKey must be omitted: %s", f.LastSSHBody())
	}

	got, err = c.AuthorizeSSH(context.Background(), cpapi.SSHAuthorizeRequest{
		Sandbox: "quiet-otter-lamp", PublicKey: "ssh-ed25519 AAAA", Fingerprint: "SHA256:abc",
	})
	if err != nil || !got.Allowed || got.Actor.UserID != "usr_1" || got.Email != "a@example.com" {
		t.Fatalf("key auth = %+v, %v", got, err)
	}
	body = nil
	if err := json.Unmarshal(f.LastSSHBody(), &body); err != nil {
		t.Fatal(err)
	}
	if _, has := body["certificate"]; has {
		t.Fatalf("nil certificate must be omitted: %s", f.LastSSHBody())
	}

	got, err = c.AuthorizeSSH(context.Background(), cpapi.SSHAuthorizeRequest{Sandbox: "x", Fingerprint: "SHA256:zzz"})
	if err != nil || got.Allowed {
		t.Fatalf("no rule: %+v, %v", got, err)
	}
	if n := f.Calls("AuthorizeSSH"); n != 3 {
		t.Fatalf("calls = %d, want 3", n)
	}
}
