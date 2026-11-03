package routes_test

import (
	"strings"
	"testing"

	"github.com/belov38/umiak/services/gateway/internal/routes"
)

func TestParseHost(t *testing.T) {
	const domain = "umiak.example.com"
	g := routes.DefaultGrammar()
	long40 := strings.Repeat("a", 40)

	tests := []struct {
		name string
		host string
		ok   bool
		want routes.Label
	}{
		{"plain", "quiet-otter-lamp-5173.umiak.example.com", true,
			routes.Label{Raw: "quiet-otter-lamp-5173", Slug: "quiet-otter-lamp", Port: 5173, Kind: "port"}},
		{"upper case and :443", "QUIET-otter-lamp-5173.UMIAK.example.com:443", true,
			routes.Label{Raw: "quiet-otter-lamp-5173", Slug: "quiet-otter-lamp", Port: 5173, Kind: "port"}},
		{"desktop", "quiet-otter-lamp-desktop.umiak.example.com", true,
			routes.Label{Raw: "quiet-otter-lamp-desktop", Slug: "quiet-otter-lamp", Port: 0, Kind: "desktop"}},
		{"numeric slug", "123-80.umiak.example.com", true,
			routes.Label{Raw: "123-80", Slug: "123", Port: 80, Kind: "port"}},
		{"slug of 40 chars", long40 + "-8080.umiak.example.com", true,
			routes.Label{Raw: long40 + "-8080", Slug: long40, Port: 8080, Kind: "port"}},
		{"port 65535", "foo-bar-65535.umiak.example.com", true,
			routes.Label{Raw: "foo-bar-65535", Slug: "foo-bar", Port: 65535, Kind: "port"}},
		{"port 1", "foo-1.umiak.example.com", true,
			routes.Label{Raw: "foo-1", Slug: "foo", Port: 1, Kind: "port"}},
		{"slug containing a reserved word", "myapi-3000.umiak.example.com", true,
			routes.Label{Raw: "myapi-3000", Slug: "myapi", Port: 3000, Kind: "port"}},

		{"apex", "umiak.example.com", false, routes.Label{}},
		{"empty host", "", false, routes.Label{}},
		{"nested labels", "a.quiet-otter-lamp-5173.umiak.example.com", false, routes.Label{}},
		{"double dash", "a--b-80.umiak.example.com", false, routes.Label{}},
		{"double dash long enough", "abc--def-80.umiak.example.com", false, routes.Label{}},
		{"slug too short", "ab-80.umiak.example.com", false, routes.Label{}},
		{"slug too long", long40 + "a-80.umiak.example.com", false, routes.Label{}},
		{"leading zero", "x-y-z-080.umiak.example.com", false, routes.Label{}},
		{"port 0", "foo-bar-0.umiak.example.com", false, routes.Label{}},
		{"port 65536", "foo-bar-65536.umiak.example.com", false, routes.Label{}},
		{"port too many digits", "foo-bar-100000.umiak.example.com", false, routes.Label{}},
		{"reserved slug", "api-3000.umiak.example.com", false, routes.Label{}},
		{"reserved slug ssh", "ssh-8080.umiak.example.com", false, routes.Label{}},
		{"reserved slug umiak", "umiak-8080.umiak.example.com", false, routes.Label{}},
		{"reserved slug desktop kind", "www-desktop.umiak.example.com", false, routes.Label{}},
		{"reserved port 22", "foo-bar-22.umiak.example.com", false, routes.Label{}},
		{"reserved port 47989", "foo-bar-47989.umiak.example.com", false, routes.Label{}},
		{"slug ending in digits segment", "quiet-otter-123-80.umiak.example.com", false, routes.Label{}},
		{"desktop slug ending in digits segment", "quiet-otter-123-desktop.umiak.example.com", false, routes.Label{}},
		{"reserved suffix with port", "foo-desktop-80.umiak.example.com", false, routes.Label{}},
		{"no port", "quiet-otter-lamp.umiak.example.com", false, routes.Label{}},
		{"leading dash", "-foo-80.umiak.example.com", false, routes.Label{}},
		{"trailing dash", "foo--80.umiak.example.com", false, routes.Label{}},
		{"underscore", "fo_o-80.umiak.example.com", false, routes.Label{}},
		{"other domain", "foo-bar-80.other.example.com", false, routes.Label{}},
		{"suffix without dot", "foo-bar-80xumiak.example.com", false, routes.Label{}},
		{"custom preview port", "foo-bar-80.umiak.example.com:8085", true, routes.Label{Raw: "foo-bar-80", Slug: "foo-bar", Port: 80, Kind: "port"}},
		{"invalid preview port", "foo-bar-80.umiak.example.com:65536", false, routes.Label{}},
		{"non-numeric preview port", "foo-bar-80.umiak.example.com:http", false, routes.Label{}},
		{"empty port", "foo-bar-80.umiak.example.com:", false, routes.Label{}},
		{"trailing dot", "foo-bar-80.umiak.example.com.", false, routes.Label{}},
		{"ip literal", "[::1]:443", false, routes.Label{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := routes.ParseHost(tc.host, domain, g)
			if ok != tc.ok {
				t.Fatalf("ParseHost(%q) ok = %v, want %v (label %+v)", tc.host, ok, tc.ok, got)
			}
			if ok && got != tc.want {
				t.Fatalf("ParseHost(%q) = %+v, want %+v", tc.host, got, tc.want)
			}
			if !ok && got != (routes.Label{}) {
				t.Fatalf("ParseHost(%q) returned %+v with ok=false", tc.host, got)
			}
		})
	}
}

func TestParseHostCustomGrammar(t *testing.T) {
	g := routes.Grammar{
		ReservedPorts:    map[uint16]bool{9999: true},
		ReservedSuffixes: []string{"desktop", "console"},
		ReservedSlugs:    []string{"admin"},
	}
	if _, ok := routes.ParseHost("foo-bar-9999.umiak.example.com", "umiak.example.com", g); ok {
		t.Error("reserved port 9999 accepted")
	}
	if _, ok := routes.ParseHost("foo-bar-22.umiak.example.com", "umiak.example.com", g); !ok {
		t.Error("port 22 must be allowed by a custom grammar without it")
	}
	if _, ok := routes.ParseHost("foo-console-80.umiak.example.com", "umiak.example.com", g); ok {
		t.Error("slug ending in a custom reserved suffix accepted")
	}
	if _, ok := routes.ParseHost("foo-console.umiak.example.com", "umiak.example.com", g); ok {
		t.Error("only the desktop suffix is a valid kind")
	}
	if _, ok := routes.ParseHost("admin-80.umiak.example.com", "umiak.example.com", g); ok {
		t.Error("reserved slug admin accepted")
	}
	if _, ok := routes.ParseHost("api-80.umiak.example.com", "umiak.example.com", g); !ok {
		t.Error("api is not reserved in this custom grammar")
	}
	// A domain given in upper case or with a leading dot still works.
	if _, ok := routes.ParseHost("foo-bar-80.umiak.example.com", "UMIAK.Example.com", g); !ok {
		t.Error("domain case must not matter")
	}
}
