package sshgw

import (
	"context"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const keepaliveRequest = "keepalive@openssh.com"

// probe is the keepalive state of one end of the connection.
type probe struct {
	conn ssh.Conn
	// result receives the outcome of the request in flight; nil when none
	// is in flight.
	result chan error
	misses int
}

// keepalive sends keepalive@openssh.com (want-reply) to the client and the
// backend every KeepaliveInterval (spec 9.4). Any reply, true or false,
// means alive. No reply by the next tick, or an error, is a miss; after
// KeepaliveMax consecutive misses on either end the connection is closed
// with reason keepalive_timeout. It returns when ctx is done.
//
// SendRequest blocks until the reply, so each probe runs in its own
// goroutine, at most one per end at a time. A probe blocked on a dead peer
// returns once the conns are closed, which follows ctx done; keepalive
// waits for its probes before returning.
func (ss *session) keepalive(ctx context.Context, backend ssh.Conn) {
	interval, maxMisses := ss.srv.cfg.KeepaliveInterval, ss.srv.cfg.KeepaliveMax
	var wg sync.WaitGroup
	defer wg.Wait()
	ends := []*probe{{conn: ss.conn}, {conn: backend}}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for _, p := range ends {
			if p.result != nil {
				select {
				case err := <-p.result:
					p.result = nil
					if err == nil {
						p.misses = 0
					} else {
						p.misses++
					}
				default:
					// Still waiting for the reply sent a tick ago.
					p.misses++
				}
			}
			if p.misses >= maxMisses {
				ss.log.Info("sshgw: keepalive timeout", "backend_end", p.conn == backend, "misses", p.misses)
				ss.closeWithReason(reasonKeepalive)
				return
			}
			if p.result == nil {
				res := make(chan error, 1)
				p.result = res
				conn := p.conn
				wg.Go(func() {
					_, _, err := conn.SendRequest(keepaliveRequest, true, nil)
					res <- err
				})
			}
		}
	}
}
