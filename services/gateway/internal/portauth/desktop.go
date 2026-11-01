package portauth

import (
	"errors"
	"net/http"
	"net/netip"
	"strings"

	"github.com/belov38/boat-dev-clone/services/gateway/internal/cpapi"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/routes"
	"github.com/belov38/boat-dev-clone/services/gateway/internal/sbxerr"
)

// CheckDesktop enforces desktop Origin, epoch cookies and one-use tickets.
// Unlike port auth, OPTIONS never bypasses authentication.
func (a *Auth) CheckDesktop(w http.ResponseWriter, r *http.Request, l routes.Label, rt cpapi.Route, ip netip.Addr, rid string, api cpapi.DesktopClient) Result {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	reject := func(status int, code string) Result {
		sbxerr.Write(w, r, sbxerr.Error{Status: status, Code: code, RequestID: rid})
		return Result{AuthResult: ResultInvalid}
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead || strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		origins := r.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != "https://"+l.Raw+"."+a.cfg.SbxDomain {
			return reject(http.StatusForbidden, "origin_forbidden")
		}
	}
	if session, ok, _ := a.validSession(r, l, ModeDesktop, rt.AuthEpoch); ok {
		return Result{Proceed: true, AuthResult: ResultOK, UserID: session.UserID, Email: session.Email}
	}
	q := r.URL.Query()
	tickets, present := q["_ticket"]
	if present && rt.Access != "public" {
		if a.blocked(w, r, ip, rid) {
			return Result{AuthResult: ResultInvalid}
		}
		if api == nil {
			return reject(http.StatusServiceUnavailable, "route_lookup_unavailable")
		}
		if len(tickets) != 1 || tickets[0] == "" || r.Method != http.MethodGet || r.URL.Path != "/" {
			return reject(http.StatusUnauthorized, "token_invalid")
		}
		grant, err := api.ExchangeDesktopTicket(r.Context(), tickets[0], l.Raw)
		if errors.Is(err, cpapi.ErrInvalidCode) {
			a.authFailure(ip)
			return reject(http.StatusUnauthorized, "token_invalid")
		}
		if err != nil {
			return reject(http.StatusServiceUnavailable, "route_lookup_unavailable")
		}
		if grant.Label != l.Raw || grant.AuthEpoch != rt.AuthEpoch {
			return reject(http.StatusUnauthorized, "token_invalid")
		}
		cookie := a.sessionCookie(Session{Label: l.Raw, Mode: ModeDesktop, Epoch: grant.AuthEpoch, UserID: grant.UserID}, a.cfg.SSOTTL)
		cookie.SameSite = http.SameSiteNoneMode
		cookie.Partitioned = true
		return Result{Proceed: true, AuthResult: ResultOK, UserID: grant.UserID, SetCookie: cookie}
	}
	switch rt.Access {
	case "public":
		return Result{Proceed: true, AuthResult: ResultOK}
	case AccessSSO:
		return a.checkSSO(w, r, l, rt, rid)
	default:
		return reject(http.StatusUnauthorized, "auth_required")
	}
}
