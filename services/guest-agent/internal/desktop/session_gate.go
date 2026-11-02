package desktop

import (
	"context"
	"os"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
)

// SessionGate records the identity+boot whose secrets the current PAM session read.
type SessionGate struct {
	Marker, IdentityBoot string
	Run                  RunCommand
}

// Start refreshes PAM once per identity/boot and preserves programs on agent restart.
func (g SessionGate) Start(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	old, _ := os.ReadFile(g.Marker)
	action := "start"
	if string(old) != g.IdentityBoot {
		action = "restart"
	}
	if _, e := g.Run(ctx, "systemctl", action, "lightdm.service"); e != nil {
		return e
	}
	return fsutil.WriteFileAtomic(g.Marker, []byte(g.IdentityBoot), 0600)
}
