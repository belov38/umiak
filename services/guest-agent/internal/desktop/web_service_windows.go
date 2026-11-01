package desktop

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/windows/svc"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

type webService struct{}

func (webService) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	l := paths.Default()
	files := os.Getenv("ProgramFiles")
	if files == "" {
		files = `C:\Program Files`
	}
	dir := filepath.Join(files, "sbx-desktop", "moonlight-web", "current")
	cmd := exec.Command(filepath.Join(dir, "web-server.exe"), "--config-path", filepath.Join(l.StateDir, "desktop-moonlight", "config.json"), "--disable-default-webrtc-ice-servers") //nolint:noctx // SCM stop controls the child lifetime
	cmd.Dir = dir
	// The service has no console: keep the output next to its config. EndStreams
	// restarts this service, so the previous run is kept as web-server.log.1.
	logPath := filepath.Join(l.StateDir, "desktop-moonlight", "web-server.log")
	_ = os.Rename(logPath, logPath+".1")
	if log, e := os.Create(logPath); e == nil {
		defer func() { _ = log.Close() }()
		cmd.Stdout = log
		cmd.Stderr = log
	}
	if e := cmd.Start(); e != nil {
		return false, 1
	}
	done := make(chan bool, 1)
	go func() { done <- (cmd.Wait() == nil) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case success := <-done:
			if !success {
				return false, 1
			}
			return false, 0
		case r := <-requests:
			switch r.Cmd {
			case svc.Interrogate:
				status <- r.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				_ = cmd.Process.Kill()
				<-done
				return false, 0
			}
		}
	}
}

// RunWebService hosts moonlight-web as a native manual SCM service.
func RunWebService(context.Context) error { return svc.Run("sbx-moonlight-web", webService{}) }
