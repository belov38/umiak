package ident

import "github.com/belov38/umiak/services/guest-agent/internal/paths"

// Resetter performs the parts of an identity reset that touch the running
// system rather than files.
type Resetter interface {
	// SetHostname sets the kernel hostname.
	SetHostname(name string) error
	// RegenerateHostKeys removes the SSH host keys and generates new ones.
	RegenerateHostKeys() error
	// ReloadNetwork makes the network stack renew its leases (best effort).
	ReloadNetwork() error
	// RestartSSH restarts sshd if it is running.
	RestartSSH() error
	// RestartJournal restarts systemd-journald if it is running, so it
	// writes under the current machine-id.
	RestartJournal() error
}

// LinuxResetter is the Resetter for Linux hosts. Its methods return
// errors.ErrUnsupported on other systems.
type LinuxResetter struct {
	Layout paths.Layout
}

// FakeResetter records calls instead of changing the system. It is meant for
// tests.
type FakeResetter struct {
	// Calls lists the invoked methods in order; SetHostname is recorded as
	// "SetHostname <name>".
	Calls []string
	// Errs maps a method name to the error it returns.
	Errs map[string]error
	// OnRegenerate, if set, runs inside RegenerateHostKeys (for example to
	// create key files).
	OnRegenerate func() error
}

var (
	_ Resetter = LinuxResetter{}
	_ Resetter = (*FakeResetter)(nil)
)

// SetHostname records the call.
func (f *FakeResetter) SetHostname(name string) error {
	f.Calls = append(f.Calls, "SetHostname "+name)
	return f.Errs["SetHostname"]
}

// RegenerateHostKeys records the call and runs OnRegenerate.
func (f *FakeResetter) RegenerateHostKeys() error {
	f.Calls = append(f.Calls, "RegenerateHostKeys")
	if err := f.Errs["RegenerateHostKeys"]; err != nil {
		return err
	}
	if f.OnRegenerate != nil {
		return f.OnRegenerate()
	}
	return nil
}

// ReloadNetwork records the call.
func (f *FakeResetter) ReloadNetwork() error {
	f.Calls = append(f.Calls, "ReloadNetwork")
	return f.Errs["ReloadNetwork"]
}

// RestartSSH records the call.
func (f *FakeResetter) RestartSSH() error {
	f.Calls = append(f.Calls, "RestartSSH")
	return f.Errs["RestartSSH"]
}

// RestartJournal records the call.
func (f *FakeResetter) RestartJournal() error {
	f.Calls = append(f.Calls, "RestartJournal")
	return f.Errs["RestartJournal"]
}
