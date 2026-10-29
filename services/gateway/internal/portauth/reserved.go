package portauth

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"net/netip"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/sbxerr"
)

// ReservedPrefix is the path prefix the gateway never proxies (spec 8.4).
const ReservedPrefix = "/__sbx/"

// Reserved endpoints.
const (
	CallbackPath = "/__sbx/auth/callback"
	LogoutPath   = "/__sbx/auth/logout"
)

// ServeReserved answers a request under /__sbx/. rt is nil when the route
// lookup failed; the callback then refuses and logout still works.
func (a *Auth) ServeReserved(w http.ResponseWriter, r *http.Request, l routes.Label, rt *cpapi.Route, ip netip.Addr, requestID string) {
	switch r.URL.Path {
	case CallbackPath:
		a.callback(w, r, l, rt, ip, requestID)
	case LogoutPath:
		h := w.Header()
		h.Add("Set-Cookie", a.cookie(AuthCookie, "", 0).String())
		h.Add("Set-Cookie", a.cookie(StateCookie, "", 0).String())
		a.redirect(w, "/")
	default:
		sbxerr.Write(w, r, sbxerr.Error{Status: http.StatusNotFound, Code: sbxerr.CodeRouteNotFound, RequestID: requestID})
	}
}

// errCallback marks a callback refusal: 401 auth_required plus one auth
// failure of the IP.
var errCallback = errors.New("portauth: callback refused")

// callback finishes the sso login (spec 8.4). Everything that does not need
// api is checked before the code is exchanged, so a bad request never burns
// the user's code.
func (a *Auth) callback(w http.ResponseWriter, r *http.Request, l routes.Label, rt *cpapi.Route, ip netip.Addr, requestID string) {
	if a.blocked(w, r, ip, requestID) {
		a.count(AccessSSO, ResultInvalid)
		return
	}
	s, rd, err := a.finishLogin(r, l, rt)
	switch {
	case err == nil:
	case errors.Is(err, errCallback):
		a.authFailure(ip)
		a.count(AccessSSO, ResultInvalid)
		sbxerr.Write(w, r, sbxerr.Error{Status: http.StatusUnauthorized, Code: sbxerr.CodeAuthRequired, RequestID: requestID})
		return
	default:
		// api could not answer. The user did nothing wrong, and the code
		// may still be valid for a retry.
		sbxerr.Write(w, r, sbxerr.Error{
			Status:    http.StatusServiceUnavailable,
			Code:      sbxerr.CodeRouteLookupUnavailable,
			Retryable: true,
			RequestID: requestID,
		})
		return
	}

	h := w.Header()
	h.Add("Set-Cookie", a.sessionCookie(s, a.cfg.SSOTTL).String())
	h.Add("Set-Cookie", a.cookie(StateCookie, "", 0).String())
	h.Set("Referrer-Policy", "no-referrer")
	a.count(AccessSSO, ResultOK)
	a.redirect(w, rd)
}

// finishLogin validates the callback and exchanges the code. It returns
// errCallback for every refusal and another error when api is unavailable.
func (a *Auth) finishLogin(r *http.Request, l routes.Label, rt *cpapi.Route) (Session, string, error) {
	q := r.URL.Query()
	code, state := q.Get("code"), q.Get("state")
	if code == "" || state == "" {
		return Session{}, "", errCallback
	}
	st, ok := a.stateCookie(r, l, state)
	if !ok {
		return Session{}, "", errCallback
	}
	if rt == nil || rt.Access != AccessSSO {
		return Session{}, "", errCallback
	}

	g, err := a.cfg.API.ExchangePortAuthCode(r.Context(), code, l.Raw)
	switch {
	case err == nil:
	case errors.Is(err, cpapi.ErrInvalidCode):
		return Session{}, "", errCallback
	default:
		return Session{}, "", err
	}
	// The epoch check catches an access change between the redirect and
	// the exchange.
	if g.Label != l.Raw || g.AuthEpoch != rt.AuthEpoch {
		return Session{}, "", errCallback
	}
	s := Session{Label: l.Raw, Mode: ModeSSO, Epoch: g.AuthEpoch, UserID: g.UserID, Email: g.Email}
	return s, safeRD(st.RD), nil
}

// stateCookie finds a valid state cookie of l whose state equals want.
func (a *Auth) stateCookie(r *http.Request, l routes.Label, want string) (State, bool) {
	for _, c := range r.Cookies() {
		if c.Name != StateCookie {
			continue
		}
		st, err := a.cfg.Codec.OpenState(c.Value)
		if err != nil || st.Label != l.Raw {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(st.State), []byte(want)) == 1 {
			return st, true
		}
	}
	return State{}, false
}
