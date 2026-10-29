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
		a.logout(w, r)
	default:
		sbxerr.Write(w, r, sbxerr.Error{Status: http.StatusNotFound, Code: sbxerr.CodeRouteNotFound, RequestID: requestID})
	}
}

// logout clears the auth cookie and every state cookie the request carries.
func (a *Auth) logout(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Add("Set-Cookie", a.cookie(AuthCookie, "", 0).String())
	seen := map[string]bool{}
	for _, c := range r.Cookies() {
		if isStateCookie(c.Name) && !seen[c.Name] {
			seen[c.Name] = true
			h.Add("Set-Cookie", a.cookie(c.Name, "", 0).String())
		}
	}
	a.redirect(w, "/")
}

var (
	// errNoState: the request carries no state cookie for its state param
	// (another tab finished first, the cookie expired, or a stray link).
	// 401 auth_required without an auth failure.
	errNoState = errors.New("portauth: no state cookie")
	// errCallback: a refusal that counts as an auth failure of the IP.
	errCallback = errors.New("portauth: callback refused")
)

// login is a validated callback.
type login struct {
	session     Session
	rd          string
	stateCookie string
}

// callback finishes the sso login (spec 8.4). Everything that does not need
// api is checked before the code is exchanged, so a bad request never burns
// the user's code.
func (a *Auth) callback(w http.ResponseWriter, r *http.Request, l routes.Label, rt *cpapi.Route, ip netip.Addr, requestID string) {
	if a.blocked(w, r, ip, requestID) {
		a.count(AccessSSO, ResultInvalid)
		return
	}
	in, err := a.finishLogin(r, l, rt)
	switch {
	case err == nil:
	case errors.Is(err, errNoState):
		a.count(AccessSSO, ResultMissing)
		sbxerr.Write(w, r, sbxerr.Error{Status: http.StatusUnauthorized, Code: sbxerr.CodeAuthRequired, RequestID: requestID})
		return
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
	h.Add("Set-Cookie", a.sessionCookie(in.session, a.cfg.SSOTTL).String())
	h.Add("Set-Cookie", a.cookie(in.stateCookie, "", 0).String())
	h.Set("Referrer-Policy", "no-referrer")
	a.count(AccessSSO, ResultOK)
	a.redirect(w, in.rd)
}

// finishLogin validates the callback and exchanges the code. It returns
// errNoState or errCallback for refusals and another error when api is
// unavailable.
func (a *Auth) finishLogin(r *http.Request, l routes.Label, rt *cpapi.Route) (login, error) {
	q := r.URL.Query()
	code, state := q.Get("code"), q.Get("state")
	name, ok := stateCookieName(state)
	if !ok {
		return login{}, errNoState
	}
	st, err := a.stateCookie(r, name, l, state)
	if err != nil {
		return login{}, err
	}
	if code == "" || rt == nil || rt.Access != AccessSSO {
		return login{}, errCallback
	}

	g, err := a.cfg.API.ExchangePortAuthCode(r.Context(), code, l.Raw)
	switch {
	case err == nil:
	case errors.Is(err, cpapi.ErrInvalidCode):
		return login{}, errCallback
	default:
		return login{}, err
	}
	// The epoch check catches an access change between the redirect and
	// the exchange.
	if g.Label != l.Raw || g.AuthEpoch != rt.AuthEpoch {
		return login{}, errCallback
	}
	return login{
		session:     Session{Label: l.Raw, Mode: ModeSSO, Epoch: g.AuthEpoch, UserID: g.UserID, Email: g.Email},
		rd:          safeRD(st.RD),
		stateCookie: name,
	}, nil
}

// stateCookie opens the cookie name and checks it belongs to l and holds
// exactly want. No such cookie gives errNoState; a cookie that does not open
// or does not match gives errCallback.
func (a *Auth) stateCookie(r *http.Request, name string, l routes.Label, want string) (State, error) {
	present := false
	for _, c := range r.Cookies() {
		if c.Name != name {
			continue
		}
		present = true
		st, err := a.cfg.Codec.OpenState(c.Value)
		if err != nil || st.Label != l.Raw {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(st.State), []byte(want)) == 1 {
			return st, nil
		}
	}
	if !present {
		return State{}, errNoState
	}
	return State{}, errCallback
}
