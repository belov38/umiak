package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// doctorUnits are the units whose state doctor reports, by report key.
var doctorUnits = []struct{ key, unit string }{
	{"sbx-identity", "sbx-identity.service"},
	{"sbx-agent", "sbx-agent.service"},
}

// DoctorOptions holds the OS-specific parts of Doctor.
type DoctorOptions struct {
	// Source reads the smbios identity for the effective tunnel URL; nil
	// reports the agent.toml URL.
	Source ident.Source
	// IsActive returns the state of a systemd unit (systemctl is-active).
	// Default SystemctlIsActive.
	IsActive func(ctx context.Context, unit string) string
	// Statfs reports the size and free space of a filesystem. Default
	// output.DefaultStatfs.
	Statfs func(path string) (total, free uint64, err error)
	// TestAids names the build-time test aids of the binary (failRun,
	// devUpdateKey); empty for a production build.
	TestAids []string
}

// Report is the result of `sbx-agent doctor` (spec 17.6, S5 17.3). It never
// holds the boot secret or the machine token.
type Report struct {
	Versions VersionsReport `json:"versions"`
	// Units maps sbx-identity and sbx-agent to their systemctl is-active
	// state.
	Units map[string]string `json:"units"`
	// Identity is identity.json; IdentityError explains a missing one.
	Identity      *IdentityReport `json:"identity"`
	IdentityError string          `json:"identity_error,omitempty"`
	TunnelURL     TunnelURLReport `json:"tunnel_url"`
	// Readiness comes from status.json (the running agent).
	Readiness *ReadinessStatus `json:"readiness"`
	// Status is status.json as written by the agent; StatusError explains a
	// missing or unreadable one.
	Status      json.RawMessage `json:"status"`
	StatusError string          `json:"status_error,omitempty"`
	// Quiesce is the active lease file, or null.
	Quiesce *quiesce.Lease `json:"quiesce"`
	Disk    DiskReport     `json:"disk"`
	// IdentityDir is the smbios directory the identity is read from.
	IdentityDir string `json:"identity_dir"`
	// TestAids lists the test aids in effect: build-time ones of the binary
	// and identity.sysfs_dir when it is not the sysfs default. A template
	// must have none.
	TestAids []string `json:"test_aids,omitempty"`
}

// VersionsReport names the targets of the current and previous links.
type VersionsReport struct {
	Current  string `json:"current"`
	Previous string `json:"previous"`
	Error    string `json:"error,omitempty"`
}

// IdentityReport is identity.json.
type IdentityReport struct {
	MachineID           string   `json:"machine_id"`
	WrittenMachineID    string   `json:"written_machine_id"`
	HostKeyFingerprints []string `json:"host_key_fingerprints"`
	ResetPending        bool     `json:"reset_pending"`
}

// TunnelURLReport is the effective tunnel URL and its source (smbios or
// config).
type TunnelURLReport struct {
	URL    string `json:"url"`
	Source string `json:"source"`
	// Warning explains why the smbios override could not be checked.
	Warning string `json:"warning,omitempty"`
}

// DiskReport is the space of the filesystem holding the state directory.
type DiskReport struct {
	Path       string `json:"path"`
	TotalBytes uint64 `json:"total_bytes"`
	FreeBytes  uint64 `json:"free_bytes"`
	Error      string `json:"error,omitempty"`
}

// Doctor collects the diagnostics of `sbx-agent doctor`. It works with or
// without a running agent and never fails as a whole: a part that cannot be
// read carries its error.
func Doctor(ctx context.Context, l paths.Layout, cfg config.Config, opts DoctorOptions) *Report {
	if opts.IsActive == nil {
		opts.IsActive = SystemctlIsActive
	}
	if opts.Statfs == nil {
		opts.Statfs = output.DefaultStatfs
	}
	r := &Report{Units: map[string]string{}}

	var verr []string
	var err error
	if r.Versions.Current, err = update.LinkVersion(l.CurrentLink); err != nil {
		verr = append(verr, err.Error())
	}
	if r.Versions.Previous, err = update.LinkVersion(l.PreviousLink); err != nil {
		verr = append(verr, err.Error())
	}
	r.Versions.Error = strings.Join(verr, "; ")

	for _, u := range doctorUnits {
		r.Units[u.key] = opts.IsActive(ctx, u.unit)
	}

	if f, err := ident.LoadFile(l.IdentityFile); err == nil {
		r.Identity = &IdentityReport{
			MachineID:           f.MachineID,
			WrittenMachineID:    f.WrittenMachineID,
			HostKeyFingerprints: f.HostKeyFingerprints,
			ResetPending:        f.ResetPending,
		}
	} else {
		r.IdentityError = err.Error()
	}

	r.TunnelURL = doctorTunnelURL(ctx, opts.Source, cfg)

	if b, err := os.ReadFile(l.StatusFile); err != nil {
		r.StatusError = err.Error()
	} else {
		var s Status
		if err := json.Unmarshal(b, &s); err != nil {
			r.StatusError = "status.json: " + err.Error()
		} else {
			r.Status = json.RawMessage(bytes.TrimSpace(b))
			r.Readiness = &s.Readiness
		}
	}

	var lease quiesce.Lease
	if err := fsutil.ReadJSON(l.QuiesceFile, &lease); err == nil {
		r.Quiesce = &lease
	}

	r.IdentityDir = cfg.IdentityDir
	r.TestAids = append(r.TestAids, opts.TestAids...)
	if cfg.IdentityDir != config.DefaultIdentityDir {
		r.TestAids = append(r.TestAids, "identity.sysfs_dir")
	}

	r.Disk.Path = l.StateDir
	if total, free, err := opts.Statfs(l.StateDir); err != nil {
		r.Disk.Error = err.Error()
	} else {
		r.Disk.TotalBytes, r.Disk.FreeBytes = total, free
	}
	return r
}

// doctorTunnelURL computes the effective tunnel URL like the agent: the
// smbios family override if valid, otherwise agent.toml.
func doctorTunnelURL(ctx context.Context, src ident.Source, cfg config.Config) TunnelURLReport {
	if src == nil {
		url, source := effectiveTunnelURL("", cfg.TunnelURL)
		return TunnelURLReport{URL: url, Source: source}
	}
	var warn string
	smbios := ""
	raw, err := src.Read(ctx)
	if err == nil {
		var id ident.Identity
		id, err = ident.Parse(raw)
		smbios = id.TunnelURL
	}
	if err != nil {
		warn = "smbios identity unavailable: " + err.Error()
	}
	url, source := effectiveTunnelURL(smbios, cfg.TunnelURL)
	return TunnelURLReport{URL: url, Source: source, Warning: warn}
}

// SystemctlIsActive returns `systemctl is-active <unit>`: active, inactive,
// failed and so on, or "unknown: <error>" when systemctl cannot run.
func SystemctlIsActive(ctx context.Context, unit string) string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", "is-active", unit).Output()
	state := strings.TrimSpace(string(out))
	if state != "" {
		return state
	}
	if err != nil {
		return "unknown: " + err.Error()
	}
	return "unknown"
}

// WriteText prints r for a human.
func (r *Report) WriteText(w io.Writer) {
	p := func(format string, args ...any) { _, _ = fmt.Fprintf(w, format, args...) }
	or := func(s, def string) string {
		if s == "" {
			return def
		}
		return s
	}
	p("versions:   current %s, previous %s\n", or(r.Versions.Current, "-"), or(r.Versions.Previous, "-"))
	if r.Versions.Error != "" {
		p("            error: %s\n", r.Versions.Error)
	}
	for _, u := range doctorUnits {
		p("unit:       %s %s\n", u.unit, r.Units[u.key])
	}
	if len(r.TestAids) > 0 {
		p("test aids:  %s (not for production)\n", strings.Join(r.TestAids, ", "))
	}
	p("smbios dir: %s\n", r.IdentityDir)
	if r.Identity != nil {
		p("identity:   machine %s, reset pending %t\n", r.Identity.MachineID, r.Identity.ResetPending)
	} else {
		p("identity:   none (%s)\n", r.IdentityError)
	}
	p("tunnel url: %s (%s)\n", or(r.TunnelURL.URL, "-"), r.TunnelURL.Source)
	if r.TunnelURL.Warning != "" {
		p("            warning: %s\n", r.TunnelURL.Warning)
	}
	if r.Status == nil {
		p("agent:      no status (%s)\n", r.StatusError)
	} else {
		var s Status
		_ = json.Unmarshal(r.Status, &s)
		p("agent:      version %s, pid %d, updated %s\n", s.Version, s.PID, s.UpdatedAt.Format(time.RFC3339))
		t := s.Tunnel
		if t.Connected {
			p("tunnel:     connected to %s (conn %s, epoch %d) since %s\n", t.Gateway, t.ConnID, t.Epoch, t.Since.Format(time.RFC3339))
		} else {
			p("tunnel:     disconnected since %s\n", t.Since.Format(time.RFC3339))
		}
		if t.LastError != "" {
			p("            last error: %s\n", t.LastError)
		}
		p("identity:   %s %s\n", s.Identity.State, s.Identity.Error)
		p("log:        %d records dropped\n", s.LogDropped)
	}
	if r.Readiness != nil {
		p("readiness:  ready %t\n", r.Readiness.Ready)
		for _, ph := range r.Readiness.Phases {
			line := fmt.Sprintf("  %-10s %s", ph.Name, ph.State)
			if ph.Error != "" {
				line += " (" + ph.Error + ")"
			}
			if ph.ReadyAtMonotonicUs > 0 {
				line += fmt.Sprintf(" ready at %d us monotonic", ph.ReadyAtMonotonicUs)
			}
			p("%s\n", line)
		}
	}
	if r.Quiesce != nil {
		p("quiesce:    lease %s until %s\n", r.Quiesce.ID, r.Quiesce.Deadline.Format(time.RFC3339))
	} else {
		p("quiesce:    no lease\n")
	}
	if r.Disk.Error != "" {
		p("disk:       %s: %s\n", r.Disk.Path, r.Disk.Error)
	} else {
		p("disk:       %s: %d of %d bytes free\n", r.Disk.Path, r.Disk.FreeBytes, r.Disk.TotalBytes)
	}
}
