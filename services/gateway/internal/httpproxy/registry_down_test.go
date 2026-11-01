package httpproxy_test

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/services/gateway/internal/config"
	"github.com/belov38/umiak/services/gateway/internal/cpapi"
	"github.com/belov38/umiak/services/gateway/internal/server"
	"github.com/belov38/umiak/services/gateway/internal/testenv"
)

// A machine whose tunnel is on this instance is proxied without the
// registry (spec 6.4: local first), and a request to any other machine
// fails within the dial bounds instead of hanging, when Postgres is down
// or blackholed.
func TestProxyLocalFirstWithRegistryDown(t *testing.T) {
	const (
		dialTimeout = time.Second
		agentWait   = 500 * time.Millisecond
		// The epoch lookup (at most the dial timeout), the dial and the
		// agent wait, with room for a loaded machine.
		bound = 2*dialTimeout + agentWait + 2*time.Second
	)
	for _, tc := range []struct {
		name string
		src  registry.OwnerSource
	}{
		{"failing", func(context.Context, string) (registry.Owner, bool, error) {
			return registry.Owner{}, false, errors.New("test: registry down")
		}},
		{"blackholed", func(ctx context.Context, _ string) (registry.Owner, bool, error) {
			<-ctx.Done()
			return registry.Owner{}, false, ctx.Err()
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var queries atomic.Int64
			env := testenv.New(t, testenv.Options{Deps: func(d *server.Deps) {
				d.OwnerSource = func(ctx context.Context, id string) (registry.Owner, bool, error) {
					queries.Add(1)
					return tc.src(ctx, id)
				}
			}})
			inst := env.StartInstance(func(c *config.Config) {
				c.Timeouts.Dial = dialTimeout
				c.Timeouts.AgentWait = agentWait
			})
			m := env.NewMachine()
			m.ServeHTTP(3000, echoApp())
			c := env.PlainClient(inst)

			host := testenv.Host(env.Route(m, 3000, nil).Label)
			start := time.Now()
			getEcho(t, c, newReq(t, http.MethodGet, host, "/", nil))
			if el := time.Since(start); el > 2*time.Second {
				t.Fatalf("local request took %s", el)
			}
			if n := queries.Load(); n != 0 {
				t.Fatalf("registry queried %d times for a local machine", n)
			}

			other := testenv.Host(env.Route(nil, 3000, func(r *cpapi.Route) { r.MachineID = uuid.NewString() }).Label)
			start = time.Now()
			resp := do(t, c, newReq(t, http.MethodGet, other, "/", nil))
			el := time.Since(start)
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusServiceUnavailable && resp.StatusCode != http.StatusGatewayTimeout {
				t.Fatalf("status = %d (%s), want 503 or 504", resp.StatusCode, resp.Header.Get("Umiak-Error"))
			}
			if el > bound {
				t.Fatalf("request to a machine elsewhere took %s, want under %s", el, bound)
			}
		})
	}
}
