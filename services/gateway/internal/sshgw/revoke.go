package sshgw

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

const (
	// revokedMessage goes to the stderr of every session channel of a
	// revoked connection (spec 9.5).
	revokedMessage = "sbx: access revoked"
	// revokeNoticeTimeout is how long the notice may take before the
	// connection is closed anyway.
	revokeNoticeTimeout = time.Second
	// recheckParallel bounds the concurrent ssh/authorize calls of Recheck.
	recheckParallel = 8
	// recheckTimeout bounds one ssh/authorize call of Recheck.
	recheckTimeout = 10 * time.Second
)

// Kinds of revocation payloads.
const (
	revokeUser   = "user"
	revokeMember = "member"
	revokeKey    = "key"
	revokeTeam   = "team"
)

// revokeRule is a parsed sbx_ssh_revoke payload.
type revokeRule struct {
	kind                  string
	userID, teamID, keyID string
}

// parseRevoke parses "user:<userId>", "member:<teamId>:<userId>",
// "key:<apiKeyId>" or "team:<teamId>". The ids are opaque, non-empty and
// contain no ':'.
func parseRevoke(p string) (revokeRule, error) {
	parts := strings.Split(p, ":")
	for _, id := range parts[1:] {
		if id == "" {
			return revokeRule{}, errors.New("empty id")
		}
	}
	switch {
	case len(parts) == 2 && parts[0] == revokeUser:
		return revokeRule{kind: revokeUser, userID: parts[1]}, nil
	case len(parts) == 3 && parts[0] == revokeMember:
		return revokeRule{kind: revokeMember, teamID: parts[1], userID: parts[2]}, nil
	case len(parts) == 2 && parts[0] == revokeKey:
		return revokeRule{kind: revokeKey, keyID: parts[1]}, nil
	case len(parts) == 2 && parts[0] == revokeTeam:
		return revokeRule{kind: revokeTeam, teamID: parts[1]}, nil
	}
	return revokeRule{}, errors.New("unknown form")
}

// matches tells whether the rule covers a session of id. A member
// revocation covers the user's sessions in that team only; a team
// revocation covers every session of the team, users and keys.
func (r revokeRule) matches(id identity) bool {
	a := id.Auth
	switch r.kind {
	case revokeUser:
		return a.Actor.Kind == actorUser && a.Actor.UserID == r.userID
	case revokeMember:
		return a.Actor.Kind == actorUser && a.Actor.UserID == r.userID && a.TeamID == r.teamID
	case revokeKey:
		return a.Actor.Kind == actorTeamKey && a.Actor.APIKeyID == r.keyID
	case revokeTeam:
		return a.TeamID == r.teamID
	}
	return false
}

// Revoke handles an sbx_ssh_revoke payload (spec 9.5): the matching
// sessions get "sbx: access revoked" on every session channel and are
// closed. "" (sent after every (re)LISTEN, when notifications may have been
// lost) schedules a Recheck. A malformed payload is logged and ignored.
// Revoke does not block: the work runs on the server's queue.
func (s *Server) Revoke(payload string) {
	if payload == "" {
		s.enqueue(s.rechecks, "recheck", s.Recheck)
		return
	}
	r, err := parseRevoke(payload)
	if err != nil {
		s.log.Warn("sshgw: ignoring sbx_ssh_revoke payload", "payload", payload, "err", err)
		return
	}
	s.enqueue(s.revokes, "revoke:"+payload, func(context.Context) {
		var hit []target
		for _, t := range s.targets() {
			if r.matches(t.ident()) {
				hit = append(hit, t)
			}
		}
		if len(hit) > 0 {
			s.log.Info("sshgw: closing revoked sessions", "revoke", payload, "sessions", len(hit))
			closeRevoked(hit)
		}
	})
}

// Recheck re-runs ssh/authorize with the original request of every open
// session, marked as a recheck (api checks the identity, not the login
// certificate's validity), a few at a time, and closes the denied ones as
// revoked. A session whose check fails (api unavailable) is kept.
func (s *Server) Recheck(ctx context.Context) {
	ts := s.targets()
	if len(ts) == 0 {
		return
	}
	s.log.Info("sshgw: rechecking sessions", "sessions", len(ts))
	sem := make(chan struct{}, recheckParallel)
	var wg sync.WaitGroup
	defer wg.Wait()
	for _, t := range ts {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			return
		}
		wg.Go(func() {
			defer func() { <-sem }()
			cctx, cancel := context.WithTimeout(ctx, recheckTimeout)
			req := t.ident().Request
			req.Recheck = true
			auth, err := s.cfg.API.AuthorizeSSH(cctx, req)
			cancel()
			switch {
			case err != nil:
				s.log.Warn("sshgw: recheck failed, keeping the session", "sandbox", t.ident().Request.Sandbox, "err", err)
			case !auth.Allowed:
				s.log.Info("sshgw: recheck denied, closing the session", "sandbox", t.ident().Request.Sandbox)
				closeRevoked([]target{t})
			}
		})
	}
}

// closeRevoked writes the revocation notice to every session channel of ts,
// waits for the writes up to revokeNoticeTimeout and closes the
// connections.
func closeRevoked(ts []target) {
	dones := make([]<-chan struct{}, len(ts))
	for i, t := range ts {
		dones[i] = t.notify(revokedMessage, false)
	}
	timer := time.NewTimer(revokeNoticeTimeout)
	defer timer.Stop()
wait:
	for _, d := range dones {
		select {
		case <-d:
		case <-timer.C:
			break wait
		}
	}
	for _, t := range ts {
		t.closeWithReason(reasonRevoked)
	}
}
