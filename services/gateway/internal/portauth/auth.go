package portauth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"math"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/obs"
	"github.com/belov38/umiak/services/gateway/internal/ratelimit"
	"github.com/belov38/umiak/services/gateway/internal/routes"
	"github.com/belov38/umiak/services/gateway/internal/umiakerr"
)

// TokenHeader carries a port token for API clients and scripts (spec 8.3).
const TokenHeader = "Umiak-Port-Token"

// tokenParam is the query parameter that carries a port token.
const tokenParam = "_token"

// Route access modes handled here.
const (
	AccessToken = "token"
	AccessSSO   = "sso"
)

// AuthResult values (metric label and access log field).
const (
	ResultOK       = "ok"
	ResultMissing  = "missing"
	ResultInvalid  = "invalid"
	ResultRedirect = "redirect"
)

// Defaults for zero Config durations.
const (
	DefaultTokenTTL = 7 * 24 * time.Hour
	DefaultSSOTTL   = 12 * time.Hour
	DefaultStateTTL = 10 * time.Minute
)

// maxRDLen caps the redirect target kept in the state cookie, so that
// maxStateCookies of them stay far below the Cookie header limits. Longer
// targets become "/".
const maxRDLen = 512

// maxStateCookies caps the state cookies (logins in flight) of one host. An
// sso redirect that would exceed it clears the oldest ones, so repeated
// navigations cannot grow the Cookie header until the callback and logout
// become unreachable.
const maxStateCookies = 8

// Config configures Auth.
type Config struct {
	AuthMode      string
	Codec         *Codec
	API           cpapi.Client
	AuthURL       string // UMIAK_GATEWAY_AUTH_URL; may carry its own query
	UmiakDomain   string
	PreviewScheme string
	PreviewPort   int
	CrossSite     bool // SameSite=None; Partitioned instead of SameSite=Lax
	TokenTTL      time.Duration
	SSOTTL        time.Duration
	StateTTL      time.Duration
	Limits        *ratelimit.Limits // nil disables the auth-failure limit
	Metrics       *obs.Metrics      // nil disables metrics
}

// Auth runs the token and sso checks. It is safe for concurrent use.
type Auth struct {
	cfg Config
}

// New returns an Auth. Zero TTLs get the defaults.
func New(cfg Config) *Auth {
	if cfg.PreviewScheme == "" {
		cfg.PreviewScheme = "https"
	}
	if cfg.PreviewPort == 0 {
		cfg.PreviewPort = 443
		if cfg.PreviewScheme == "http" {
			cfg.PreviewPort = 80
		}
	}
	if cfg.TokenTTL <= 0 {
		cfg.TokenTTL = DefaultTokenTTL
	}
	if cfg.SSOTTL <= 0 {
		cfg.SSOTTL = DefaultSSOTTL
	}
	if cfg.StateTTL <= 0 {
		cfg.StateTTL = DefaultStateTTL
	}
	return &Auth{cfg: cfg}
}

// Result is the outcome of Check.
type Result struct {
	// Proceed is true when the request may go to the application. When it
	// is false, Check has already written the response.
	Proceed bool
	// Email and UserID are set for sso.
	Email, UserID string
	// AuthResult is one of ok, missing, invalid, redirect.
	AuthResult string
	// SetCookie, when set, must be added to the application's response.
	SetCookie *http.Cookie
}

// Check authorizes r for a token or sso route. Every call increments the
// auth metric once with the route access and the result. A route with any
// other access is refused (fail closed); the caller must not call Check for
// public routes.
func (a *Auth) Check(w http.ResponseWriter, r *http.Request, l routes.Label, rt cpapi.Route, ip netip.Addr, requestID string) Result {
	var res Result
	switch rt.Access {
	case AccessToken:
		res = a.checkToken(w, r, l, rt, ip, requestID)
	case AccessSSO:
		if a.cfg.AuthMode == "none" || a.cfg.PreviewScheme == "http" {
			http.Error(w, "sso_unavailable_in_local_mode: use token or public preview access", http.StatusForbidden)
			res = Result{AuthResult: ResultInvalid}
			break
		}
		res = a.checkSSO(w, r, l, rt, requestID)
	default:
		umiakerr.Write(w, r, umiakerr.Error{Status: http.StatusUnauthorized, Code: umiakerr.CodeAuthRequired, RequestID: requestID})
		res = Result{AuthResult: ResultInvalid}
	}
	a.count(rt.Access, res.AuthResult)
	return res
}

// checkToken follows spec 8.3: _token query, then Umiak-Port-Token, then the
// cookie. A token that is present is evaluated even when a valid cookie is
// also present, so an invalid _token always gives 401 token_invalid.
func (a *Auth) checkToken(w http.ResponseWriter, r *http.Request, l routes.Label, rt cpapi.Route, ip netip.Addr, requestID string) Result {
	qTok, inQuery, rest := splitToken(r.URL.RawQuery)
	hTok := r.Header.Values(TokenHeader)
	if inQuery || len(hTok) > 0 {
		if a.blocked(w, r, ip, requestID) {
			return Result{AuthResult: ResultInvalid}
		}
		tok := qTok
		if !inQuery {
			tok = hTok[0]
		}
		if !tokenMatches(tok, rt.TokenHash) {
			a.authFailure(ip)
			umiakerr.Write(w, r, umiakerr.Error{Status: http.StatusUnauthorized, Code: umiakerr.CodeTokenInvalid, RequestID: requestID})
			return Result{AuthResult: ResultInvalid}
		}
		if !inQuery {
			return Result{Proceed: true, AuthResult: ResultOK}
		}
		c := a.sessionCookie(Session{Label: l.Raw, Mode: ModeToken, Epoch: rt.AuthEpoch}, a.cfg.TokenTTL)
		if isNavigation(r) {
			h := w.Header()
			h.Set("Referrer-Policy", "no-referrer")
			h.Add("Set-Cookie", c.String())
			a.redirect(w, a.sameURL(l, r.URL.EscapedPath(), rest))
			return Result{AuthResult: ResultOK}
		}
		return Result{Proceed: true, AuthResult: ResultOK, SetCookie: c}
	}

	// A rejected cookie (stale epoch, expired) is normal after a rotation,
	// so it is not an auth failure for the rate limit.
	_, ok, present := a.validSession(r, l, ModeToken, rt.AuthEpoch)
	if ok {
		return Result{Proceed: true, AuthResult: ResultOK}
	}
	umiakerr.Write(w, r, umiakerr.Error{Status: http.StatusUnauthorized, Code: umiakerr.CodeAuthRequired, RequestID: requestID})
	return Result{AuthResult: missingOrInvalid(present)}
}

func missingOrInvalid(present bool) string {
	if present {
		return ResultInvalid
	}
	return ResultMissing
}

// checkSSO follows spec 8.4: a valid sso cookie proceeds; a browser
// navigation without one is sent to AuthURL; anything else gets 401.
func (a *Auth) checkSSO(w http.ResponseWriter, r *http.Request, l routes.Label, rt cpapi.Route, requestID string) Result {
	s, ok, present := a.validSession(r, l, ModeSSO, rt.AuthEpoch)
	if ok {
		return Result{Proceed: true, AuthResult: ResultOK, Email: s.Email, UserID: s.UserID}
	}
	if !isNavigation(r) {
		umiakerr.Write(w, r, umiakerr.Error{Status: http.StatusUnauthorized, Code: umiakerr.CodeAuthRequired, RequestID: requestID})
		return Result{AuthResult: missingOrInvalid(present)}
	}

	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on supported platforms.
		panic(err)
	}
	state := base64.RawURLEncoding.EncodeToString(b[:])
	rd := r.URL.EscapedPath()
	if r.URL.RawQuery != "" {
		rd += "?" + r.URL.RawQuery
	}
	v := a.cfg.Codec.SealState(State{
		State:  state,
		RD:     safeRD(rd),
		Label:  l.Raw,
		Expiry: a.cfg.Codec.now().Add(a.cfg.StateTTL),
	})
	name, _ := stateCookieName(state) // 22 characters: always long enough
	for _, old := range a.evictStates(r, l, name) {
		w.Header().Add("Set-Cookie", a.cookie(old, "", 0).String())
	}
	w.Header().Add("Set-Cookie", a.cookie(name, v, a.cfg.StateTTL).String())
	a.redirect(w, a.authURL(l.Raw, state))
	return Result{AuthResult: ResultRedirect}
}

// evictStates returns the state cookies of r to clear so that, with the new
// cookie fresh, at most maxStateCookies remain: first the ones that do not
// open as a state of l (forged, expired, another key or label), then the
// ones that expire first.
func (a *Auth) evictStates(r *http.Request, l routes.Label, fresh string) []string {
	type entry struct {
		name   string
		ok     bool
		expiry time.Time
	}
	var es []entry
	seen := map[string]bool{fresh: true}
	for _, c := range r.Cookies() {
		if !isStateCookie(c.Name) || seen[c.Name] {
			continue
		}
		seen[c.Name] = true
		e := entry{name: c.Name}
		if st, err := a.cfg.Codec.OpenState(c.Value); err == nil && st.Label == l.Raw {
			e.ok, e.expiry = true, st.Expiry
		}
		es = append(es, e)
	}
	n := len(es) - (maxStateCookies - 1)
	if n <= 0 {
		return nil
	}
	slices.SortStableFunc(es, func(x, y entry) int {
		if x.ok != y.ok {
			if !x.ok {
				return -1
			}
			return 1
		}
		return x.expiry.Compare(y.expiry)
	})
	out := make([]string, n)
	for i := range out {
		out[i] = es[i].name
	}
	return out
}

// validSession looks for a valid auth cookie of l with mode and epoch. present
// reports whether any auth cookie was sent at all.
func (a *Auth) validSession(r *http.Request, l routes.Label, mode string, epoch int64) (s Session, ok, present bool) {
	for _, c := range r.Cookies() {
		if c.Name != a.authCookieName() {
			continue
		}
		present = true
		s, err := a.cfg.Codec.OpenSession(c.Value)
		if err != nil || s.Label != l.Raw || s.Mode != mode || s.Epoch != epoch {
			continue
		}
		return s, true, true
	}
	return Session{}, false, present
}

func (a *Auth) authURL(label, state string) string {
	u := a.cfg.AuthURL
	switch {
	case !strings.Contains(u, "?"):
		u += "?"
	case !strings.HasSuffix(u, "?") && !strings.HasSuffix(u, "&"):
		u += "&"
	}
	return u + "label=" + url.QueryEscape(label) + "&state=" + url.QueryEscape(state)
}

// sameURL returns the redirect target for path and raw query. A path that a
// browser would read as protocol-relative (//host or /\host) gets an
// absolute URL on the label's own host instead.
func (a *Auth) sameURL(l routes.Label, path, rawQuery string) string {
	target := path
	if target == "" {
		target = "/"
	}
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	if safePath(target) {
		return target
	}
	return a.previewOrigin(l) + target
}

func (a *Auth) previewOrigin(l routes.Label) string {
	host := l.Raw + "." + a.cfg.UmiakDomain
	if a.cfg.PreviewScheme == "http" && a.cfg.PreviewPort != 80 || a.cfg.PreviewScheme == "https" && a.cfg.PreviewPort != 443 {
		host += ":" + strconv.Itoa(a.cfg.PreviewPort)
	}
	return a.cfg.PreviewScheme + "://" + host
}

// blocked writes 429 when the IP is blocked for auth failures. It must be
// called at most once per request: every true answer is counted.
func (a *Auth) blocked(w http.ResponseWriter, r *http.Request, ip netip.Addr, requestID string) bool {
	if a.cfg.Limits == nil {
		return false
	}
	blocked, left := a.cfg.Limits.AuthBlocked(ip)
	if !blocked {
		return false
	}
	retry := int(math.Ceil(left.Seconds()))
	if retry < 1 {
		retry = 1
	}
	umiakerr.Write(w, r, umiakerr.Error{
		Status:     http.StatusTooManyRequests,
		Code:       umiakerr.CodeRateLimited,
		Retryable:  true,
		RetryAfter: retry,
		RequestID:  requestID,
	})
	return true
}

func (a *Auth) authFailure(ip netip.Addr) {
	if a.cfg.Limits != nil {
		a.cfg.Limits.AuthFailure(ip)
	}
}

func (a *Auth) count(access, result string) {
	if a.cfg.Metrics != nil {
		a.cfg.Metrics.Auth.WithLabelValues(access, result).Inc()
	}
}

// sessionCookie seals s with expiry now+ttl.
func (a *Auth) sessionCookie(s Session, ttl time.Duration) *http.Cookie {
	s.Expiry = a.cfg.Codec.now().Add(ttl)
	return a.cookie(a.authCookieName(), a.cfg.Codec.SealSession(s), ttl)
}

// HTTP cookies use a separate name: browsers require Secure for __Host-.
func (a *Auth) authCookieName() string {
	if a.cfg.PreviewScheme == "http" {
		return "umiak_auth"
	}
	return AuthCookie
}

// cookie builds a gateway cookie. ttl <= 0 clears it (Max-Age=0).
func (a *Auth) cookie(name, value string, ttl time.Duration) *http.Cookie {
	c := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		Secure:   a.cfg.PreviewScheme != "http",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(ttl / time.Second),
	}
	if ttl <= 0 {
		c.MaxAge = -1
	}
	if a.cfg.CrossSite && a.cfg.PreviewScheme != "http" {
		c.SameSite = http.SameSiteNoneMode
		c.Partitioned = true
	}
	return c
}

// redirect writes a 302 without http.Redirect, which would clean the path.
func (a *Auth) redirect(w http.ResponseWriter, location string) {
	h := w.Header()
	h.Set("Location", location)
	h.Set("Cache-Control", "no-store")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	w.WriteHeader(http.StatusFound)
}

// tokenMatches compares lowercase hex sha256(tok) with hash in constant time.
func tokenMatches(tok, hash string) bool {
	if tok == "" || hash == "" {
		return false
	}
	sum := sha256.Sum256([]byte(tok))
	got := hex.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(got), []byte(strings.ToLower(hash))) == 1
}

// isNavigation reports a browser navigation: GET or HEAD, Accept contains
// text/html, no Upgrade.
func isNavigation(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.Header.Get("Upgrade") != "" {
		return false
	}
	for _, v := range r.Header.Values("Accept") {
		if strings.Contains(strings.ToLower(v), "text/html") {
			return true
		}
	}
	return false
}

// safePath reports whether p is a same-origin path: it starts with "/" but
// not with "//" or "/\".
func safePath(p string) bool {
	return strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") && !strings.HasPrefix(p, "/\\")
}

// safeRD returns rd when it is a safe same-origin path no longer than
// maxRDLen, and "/" otherwise.
func safeRD(rd string) string {
	if len(rd) > maxRDLen || !safePath(rd) {
		return "/"
	}
	return rd
}

// splitToken scans a raw query for _token parameters. It returns the
// unescaped value of the first one, whether any was found, and the raw query
// without them (other params unchanged and in order). Keys are compared after
// unescaping, so %5Ftoken counts too. A key that does not unescape is kept.
func splitToken(raw string) (tok string, found bool, rest string) {
	if raw == "" {
		return "", false, ""
	}
	var kept []string
	for part := range strings.SplitSeq(raw, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		key, err := url.QueryUnescape(k)
		if err != nil || key != tokenParam {
			kept = append(kept, part)
			continue
		}
		if !found {
			found = true
			// An undecodable value stays empty, which never matches.
			tok, _ = url.QueryUnescape(v)
		}
	}
	if !found {
		return "", false, raw
	}
	return tok, true, strings.Join(kept, "&")
}
