package umiakerr

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUmiakerrHTML(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	r.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
	w := httptest.NewRecorder()
	Write(w, r, Error{
		Status:    http.StatusServiceUnavailable,
		Code:      CodeSandboxStarting,
		Message:   `Starting <script>alert("x")</script> & more`,
		Retryable: true,
		RequestID: "req<1>",
	})
	res := w.Result()
	body := w.Body.String()

	if res.StatusCode != 503 {
		t.Errorf("status = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q", ct)
	}
	if res.Header.Get("Umiak-Error") != "sandbox_starting" {
		t.Errorf("Umiak-Error = %q", res.Header.Get("Umiak-Error"))
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q", res.Header.Get("Cache-Control"))
	}
	if res.Header.Get("X-Robots-Tag") != "noindex, nofollow" {
		t.Errorf("X-Robots-Tag = %q", res.Header.Get("X-Robots-Tag"))
	}
	if res.Header.Get("Retry-After") != "" {
		t.Errorf("Retry-After should be absent")
	}
	for _, bad := range []string{"src=", "href=http", "href=\"http", "<script", "@import", "url("} {
		if strings.Contains(body, bad) {
			t.Errorf("body contains %q:\n%s", bad, body)
		}
	}
	if !strings.Contains(body, "&lt;script&gt;") || !strings.Contains(body, "&amp; more") {
		t.Errorf("message not escaped:\n%s", body)
	}
	if strings.Contains(body, "req<1>") || !strings.Contains(body, "req&lt;1&gt;") {
		t.Errorf("request id not escaped:\n%s", body)
	}
	if strings.Contains(body, `http-equiv="refresh"`) {
		t.Errorf("unexpected refresh meta")
	}
}

func TestUmiakerrRefresh(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	r.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	Write(w, r, Error{Status: 503, Code: CodeAgentUnavailable, Retryable: true, RetryAfter: 5, Refresh: true})
	if !strings.Contains(w.Body.String(), `<meta http-equiv="refresh" content="5">`) {
		t.Errorf("refresh meta missing:\n%s", w.Body.String())
	}
	if w.Header().Get("Retry-After") != "5" {
		t.Errorf("Retry-After = %q", w.Header().Get("Retry-After"))
	}
	// JSON responses never carry the meta tag.
	r2 := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	w2 := httptest.NewRecorder()
	Write(w2, r2, Error{Status: 503, Code: CodeAgentUnavailable, Refresh: true})
	if strings.Contains(w2.Body.String(), "refresh") {
		t.Errorf("json body has refresh: %s", w2.Body.String())
	}
}

func TestUmiakerrJSON(t *testing.T) {
	for _, accept := range []string{"", "application/json", "*/*"} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
		if accept != "" {
			r.Header.Set("Accept", accept)
		}
		w := httptest.NewRecorder()
		Write(w, r, Error{Status: 429, Code: CodeRateLimited, Message: "Slow down", Retryable: true, RetryAfter: 12, RequestID: "r1"})
		res := w.Result()
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("accept %q: Content-Type = %q", accept, ct)
		}
		for h, v := range map[string]string{
			"Umiak-Error":   "rate_limited",
			"Cache-Control": "no-store",
			"X-Robots-Tag":  "noindex, nofollow",
			"Retry-After":   "12",
		} {
			if res.Header.Get(h) != v {
				t.Errorf("accept %q: %s = %q, want %q", accept, h, res.Header.Get(h), v)
			}
		}
		var got struct {
			Error map[string]any `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"code": "rate_limited", "message": "Slow down", "retryable": true, "requestId": "r1"}
		if len(got.Error) != len(want) {
			t.Errorf("error object = %v", got.Error)
		}
		for k, v := range want {
			if got.Error[k] != v {
				t.Errorf("error.%s = %v, want %v", k, got.Error[k], v)
			}
		}
		if res.StatusCode != 429 {
			t.Errorf("status = %d", res.StatusCode)
		}
	}
}

func TestUmiakerrDefaults(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	Write(w, r, Error{Status: 404, Code: CodeRouteNotFound})
	var got struct {
		Error struct{ Message string }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Error.Message == "" {
		t.Error("empty message should fall back to a default text")
	}

	w = httptest.NewRecorder()
	Write(w, nil, Error{Code: CodeUpstreamError})
	if w.Code != 500 {
		t.Errorf("zero status should become 500, got %d", w.Code)
	}
}

func TestUmiakerrHead(t *testing.T) {
	r := httptest.NewRequestWithContext(t.Context(), http.MethodHead, "/", nil)
	r.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	Write(w, r, Error{Status: 404, Code: CodeRouteNotFound})
	if w.Body.Len() != 0 {
		t.Errorf("HEAD must not have a body")
	}
	if w.Header().Get("Umiak-Error") != "route_not_found" {
		t.Errorf("Umiak-Error missing on HEAD")
	}
}

func TestCodesDistinct(t *testing.T) {
	codes := []string{
		CodeRouteNotFound, CodeRouteBlocked, CodeAuthRequired, CodeTokenInvalid, CodeRateLimited,
		CodeAppNotListening, CodeUpstreamError, CodeSandboxStarting, CodeSandboxStopped,
		CodeSandboxUnavailable, CodeAgentUnavailable, CodeRouteLookupUnavailable, CodeOverloaded, CodeAppTimeout,
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if c == "" || seen[c] {
			t.Errorf("bad or duplicate code %q", c)
		}
		seen[c] = true
	}
}
