package agent

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/host"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/system"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// agentPackage is the proto package of the agent API.
const agentPackage = "sbx.agent.v1"

// CapQuiesceWipeSecrets is announced on Windows only: Quiesce accepts
// wipe_secret_files and PrepareStop reports secret_files_wiped.
const CapQuiesceWipeSecrets = "system.quiesce.wipe_secrets.v1"

// capabilities are announced in Control/Info (spec section 13, S2 10.2).
var capabilities = []string{
	"process.v1",
	"process.pty",
	"process.stdin",
	"files.v1",
	"files.upload.v1",
	"files.archive.v1",
	"system.claim.v1",
	"system.quiesce.v1",
	"system.update.v1",
	"system.ports.v1",
	"system.metrics.v1",
	"system.activity.v1",
}

// infoResponse is the Control/Info answer. The tunnel library appends
// sbx.tunnel.v1 to the proto packages.
func (a *agent) infoResponse() *tunnelv1.InfoResponse {
	return &tunnelv1.InfoResponse{
		AgentVersion:  a.version,
		Os:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		ProtoPackages: []string{agentPackage},
		Capabilities:  slices.Clone(capabilities),
	}
}

// tunnelInfo is tunnelagent.Config.Info: Control/Info served over the
// tunnel, which counts toward the update confirmation.
func (a *agent) tunnelInfo(context.Context) *tunnelv1.InfoResponse {
	res := a.infoResponse()
	a.confirm.tunnelInfo()
	return res
}

// newMux routes the agent API: the Process, Filesystem and System Connect
// services and the /files endpoints. It is a plain prefix switch on the raw
// request path, like the tunnel library's own route: no http.ServeMux
// cleaning or redirect touches the path before the files handler sees it.
func (a *agent) newMux() http.Handler {
	procPath, procH := a.proc.Handler()
	fsPath, fsH := a.files.ConnectHandler()
	sysPath, sysH := a.system.ConnectHandler()
	filesH := a.files.HTTPHandler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case strings.HasPrefix(p, procPath):
			procH.ServeHTTP(w, r)
		case strings.HasPrefix(p, fsPath):
			fsH.ServeHTTP(w, r)
		case strings.HasPrefix(p, sysPath):
			sysH.ServeHTTP(w, r)
		case p == "/files" || strings.HasPrefix(p, "/files/"):
			filesH.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

// staticInfo is the system.InfoSource of the agent.
type staticInfo struct{ a *agent }

// bootTime is read once per process.
var bootTime = sync.OnceValue(func() time.Time {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	secs, err := host.BootTimeWithContext(ctx)
	if err != nil || secs == 0 {
		return time.Time{}
	}
	return time.Unix(int64(secs), 0).UTC() //nolint:gosec // boot time fits int64
})

// Static implements system.InfoSource.
func (s staticInfo) Static() system.StaticInfo {
	a := s.a
	prev, _ := update.LinkVersion(a.l.PreviousLink)
	url, source := a.identity.tunnelURL()
	return system.StaticInfo{
		Version:         a.version,
		PreviousVersion: prev,
		OS:              runtime.GOOS,
		Arch:            runtime.GOARCH,
		Kernel:          kernelRelease(),
		BootID:          a.bootID,
		MachineID:       a.identity.machineID(),
		DefaultUser:     a.cfg.DefaultUser,
		TunnelURL:       url,
		TunnelURLSource: source,
		BootTime:        bootTime(),
		SSHHostKeys:     sshHostKeys(a.l.SSHDir),
	}
}

// sshHostKeys returns the public SSH host keys (ssh_host_*.pub lines),
// sorted.
func sshHostKeys(dir string) []string {
	matches, _ := filepath.Glob(filepath.Join(dir, "ssh_host_*.pub"))
	var out []string
	for _, m := range matches {
		b, err := os.ReadFile(m)
		if err != nil {
			continue
		}
		if line := strings.TrimSpace(string(b)); line != "" {
			out = append(out, line)
		}
	}
	slices.Sort(out)
	return out
}
