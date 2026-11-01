package desktop

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSunshineTLSRequiresExactPrivateCertificate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "cert.pem")
	_ = os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600)
	client := pinnedSunshineClient(path)
	request, _ := http.NewRequestWithContext(t.Context(), "GET", server.URL, nil)
	res, e := client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	_ = res.Body.Close()
	client.CloseIdleConnections()
	_ = os.WriteFile(path, []byte("different certificate"), 0600)
	res, e = client.Do(request)
	if e == nil {
		_ = res.Body.Close()
		t.Fatal("accepted wrong certificate")
	}
}
