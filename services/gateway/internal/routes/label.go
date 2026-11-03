// Package routes turns a Host header into a route label (spec 4.2), caches
// route lookups (6.2) and maps the sandbox state to a gateway answer (6.3).
package routes

import (
	"net"
	"strings"
)

// Label kinds.
const (
	KindPort    = "port"
	KindDesktop = "desktop"
)

const (
	minSlugLen = 3
	maxSlugLen = 40
	// maxLabelLen is the DNS limit for one label.
	maxLabelLen = 63
)

// Label is a parsed host label such as "quiet-otter-lamp-5173".
type Label struct {
	Raw  string // lower-case label; also the cache key
	Slug string
	Port uint16 // 0 for the desktop kind
	Kind string // KindPort or KindDesktop
}

// Grammar holds the platform constants that the label grammar depends on.
type Grammar struct {
	// ReservedPorts cannot be published; their labels do not parse.
	ReservedPorts map[uint16]bool
	// ReservedSuffixes are slug suffixes reserved for service hosts. Only
	// "desktop" is a valid host kind; a slug that ends in any of them is
	// never a plain port label.
	ReservedSuffixes []string
	// ReservedSlugs are whole slugs that cannot be used by sandboxes.
	ReservedSlugs []string
}

// DefaultGrammar returns the default reserved names and ports (spec 4.2, S7
// 5.4, S10).
func DefaultGrammar() Grammar {
	ports := map[uint16]bool{}
	for _, p := range []uint16{22, 47800, 47984, 47989, 47990, 48010} {
		ports[p] = true
	}
	return Grammar{
		ReservedPorts:    ports,
		ReservedSuffixes: []string{KindDesktop},
		ReservedSlugs:    []string{"api", "app", "www", "ssh", "tunnel", "admin", "static", "umiak"},
	}
}

// ParseHost parses "<label>.<umiakDomain>[:port]". It reports false for every
// host outside the grammar: another domain, the apex, nested labels, a
// trailing dot, an invalid authority port, or an invalid label.
func ParseHost(host, umiakDomain string, g Grammar) (Label, bool) {
	host = strings.ToLower(host)
	if strings.Contains(host, ":") {
		name, port, err := net.SplitHostPort(host)
		if _, ok := parsePort(port); err != nil || !ok {
			return Label{}, false
		}
		host = name
	}
	if host == "" || strings.ContainsAny(host, ":[]") || strings.HasSuffix(host, ".") {
		return Label{}, false
	}
	suffix := "." + strings.ToLower(umiakDomain)
	raw, found := strings.CutSuffix(host, suffix)
	if !found || raw == "" || len(raw) > maxLabelLen || strings.Contains(raw, ".") {
		return Label{}, false
	}
	return parseLabel(raw, g)
}

func parseLabel(raw string, g Grammar) (Label, bool) {
	// A reserved suffix makes the label a service host: "<slug>-desktop".
	for _, s := range g.ReservedSuffixes {
		slug, found := strings.CutSuffix(raw, "-"+s)
		if !found || s != KindDesktop {
			continue
		}
		if !validSlug(slug, g) {
			return Label{}, false
		}
		return Label{Raw: raw, Slug: slug, Kind: KindDesktop}, true
	}

	i := strings.LastIndexByte(raw, '-')
	if i < 0 {
		return Label{}, false
	}
	slug, portStr := raw[:i], raw[i+1:]
	port, ok := parsePort(portStr)
	if !ok || g.ReservedPorts[port] || !validSlug(slug, g) {
		return Label{}, false
	}
	return Label{Raw: raw, Slug: slug, Port: port, Kind: KindPort}, true
}

// parsePort accepts [1-9][0-9]{0,4} within 1..65535.
func parsePort(s string) (uint16, bool) {
	if s == "" || len(s) > 5 || s[0] == '0' {
		return 0, false
	}
	n := 0
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + int(s[i]-'0')
	}
	if n < 1 || n > 65535 {
		return 0, false
	}
	return uint16(n), true
}

// validSlug checks the slug rules of spec 4.2 plus the reserved names.
func validSlug(slug string, g Grammar) bool {
	if len(slug) < minSlugLen || len(slug) > maxSlugLen {
		return false
	}
	segs := strings.Split(slug, "-")
	for _, s := range segs {
		if s == "" { // leading, trailing or double "-"
			return false
		}
		for i := range len(s) {
			c := s[i]
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') {
				return false
			}
		}
	}
	// A slug ending in "-<digits>" would make the port ambiguous.
	if len(segs) > 1 && allDigits(segs[len(segs)-1]) {
		return false
	}
	for _, r := range g.ReservedSlugs {
		if slug == r {
			return false
		}
	}
	for _, s := range g.ReservedSuffixes {
		if strings.HasSuffix(slug, "-"+s) {
			return false
		}
	}
	return true
}

func allDigits(s string) bool {
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}
