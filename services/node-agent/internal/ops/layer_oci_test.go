package ops

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestLayerOCIAuthenticatesAnonymouslyWithPullOnlyScope(t *testing.T) {
	var address string
	tokens := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			tokens++
			if r.URL.Query().Get("scope") != "repository:fixture/layer:pull" || r.Header.Get("Authorization") != "" {
				t.Error("unsafe token scope/credentials")
			}
			_, _ = io.WriteString(w, `{"token":"fixture-anonymous-token","expires_in":300}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fixture-anonymous-token" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+address+`/token",service="registry",scope="repository:fixture/layer:pull"`)
			w.WriteHeader(401)
			return
		}
		_, _ = io.WriteString(w, "fixture")
	}))
	defer server.Close()
	address = server.URL
	base, e := layerRegistryBase(address, "fixture/layer")
	if e != nil {
		t.Fatal(e)
	}
	client, e := layerOCIClient(server.Client(), base)
	if e != nil {
		t.Fatal(e)
	}
	for range 2 {
		response, e := client.Get(base + "/blobs/sha256:" + strings.Repeat("a", 64))
		if e != nil {
			t.Fatal(e)
		}
		if response.StatusCode != 200 {
			t.Fatal("anonymous auth failed")
		}
		_ = response.Body.Close()
	}
	if tokens != 1 {
		t.Fatal("anonymous token was not reused")
	}
}
func TestLayerOCIRedirectGuardAllowsOnlyRegistryAndGHCRBlobCDN(t *testing.T) {
	origin, _ := url.Parse("https://ghcr.io")
	for _, v := range []struct {
		target  string
		allowed bool
	}{{"https://pkg-containers.githubusercontent.com/blob?signature=fixture", true}, {"https://ghcr.io/v2/x", true}, {"https://pkg-containers.githubusercontent.com.evil.invalid/x", false}, {"http://pkg-containers.githubusercontent.com/x", false}, {"https://user:pass@pkg-containers.githubusercontent.com/x", false}, {"https://127.0.0.1/x", false}} {
		target, _ := url.Parse(v.target)
		if layerOCIRedirectAllowed(origin, target) != v.allowed {
			t.Fatal("incorrect OCI redirect guard", v.target)
		}
	}
}
