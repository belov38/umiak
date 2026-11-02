package ident

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/winapi"
)

const (
	cryptographyKey = `SOFTWARE\Microsoft\Cryptography`
	winlogonKey     = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`
	// autologonSecret is the LSA secret Winlogon reads the autologon
	// password from.
	autologonSecret = "DefaultPassword"
	// keygenTimeout bounds ssh-keygen -A (RSA 3072 generation included).
	keygenTimeout = 2 * time.Minute
)

// WindowsResetter is the WinResetter of a Windows machine.
type WindowsResetter struct {
	Layout paths.Layout
	// Wipe overwrites and removes the secrets directory
	// (claim.WipeSecretsDir; ident cannot import claim).
	Wipe func() error
}

var _ WinResetter = WindowsResetter{}

// SetMachineGUID writes MachineGuid in the 64-bit registry view.
func (WindowsResetter) SetMachineGUID(guid string) error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, cryptographyKey, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return fmt.Errorf("ident: open %s: %w", cryptographyKey, err)
	}
	defer k.Close() //nolint:errcheck // the value is written by SetStringValue
	return k.SetStringValue("MachineGuid", guid)
}

// RegenerateHostKeys removes ssh_host_* from the SSH directory, runs the
// built-in ssh-keygen -A there and gives every new key file the ACL sshd
// requires.
func (r WindowsResetter) RegenerateHostKeys() error {
	dir := r.Layout.SSHDir
	if err := removeHostKeys(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		return fmt.Errorf("ident: system directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), keygenTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(sys, "OpenSSH", "ssh-keygen.exe"), "-A")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ident: ssh-keygen -A: %w: %s", err, truncate(out, 512))
	}
	keys, err := filepath.Glob(filepath.Join(dir, "ssh_host_*"))
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return errors.New("ident: ssh-keygen -A created no host keys")
	}
	for _, k := range keys {
		if err := secureSSHFile(k); err != nil {
			return err
		}
	}
	return nil
}

// SetComputerName sets the DNS host name, which also sets the NetBIOS name.
func (WindowsResetter) SetComputerName(name string) error {
	return winapi.SetComputerNameEx(windows.ComputerNamePhysicalDnsHostname, name)
}

// ActiveComputerName returns the DNS host name in effect now.
func (WindowsResetter) ActiveComputerName() (string, error) {
	return winapi.GetComputerNameEx(windows.ComputerNamePhysicalDnsHostname)
}

// NewUserPassword sets a new random password for the local account user,
// stores it in the LSA secrets of the agent and of autologon and enables
// autologon of user. The password never reaches a file.
func (WindowsResetter) NewUserPassword(user string) error {
	pw, err := newPassword(user)
	if err != nil {
		return err
	}
	defer clear(pw)
	if err := winapi.SetUserPassword(user, pw); err != nil {
		return err
	}
	// The agent reads L$umiak_user as UTF-8 bytes (winapi.LogonUserToken).
	if err := winapi.LsaStore(winapi.SecretUserPassword, pw); err != nil {
		return err
	}
	// Winlogon reads DefaultPassword as a UTF-16LE string (no terminator).
	u := utf16LE(pw)
	defer clear(u)
	if err := winapi.LsaStore(autologonSecret, u); err != nil {
		return err
	}
	return setAutologon(user)
}

// setAutologon writes the Winlogon autologon values for the local account
// user. A plain-text DefaultPassword value or a logon count limit left in
// the registry is removed: the password comes from the LSA secret.
func setAutologon(user string) error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, winlogonKey, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return fmt.Errorf("ident: open %s: %w", winlogonKey, err)
	}
	defer k.Close() //nolint:errcheck // values are written by the setters
	for name, v := range map[string]string{
		"AutoAdminLogon":    "1",
		"DefaultUserName":   user,
		"DefaultDomainName": ".",
	} {
		if err := k.SetStringValue(name, v); err != nil {
			return fmt.Errorf("ident: set Winlogon %s: %w", name, err)
		}
	}
	for _, name := range []string{"DefaultPassword", "AutoLogonCount"} {
		if err := k.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return fmt.Errorf("ident: delete Winlogon %s: %w", name, err)
		}
	}
	return nil
}

// WipeSecrets runs Wipe.
func (r WindowsResetter) WipeSecrets() error {
	if r.Wipe == nil {
		return errors.New("ident: no secrets wiper configured")
	}
	return r.Wipe()
}

// Reboot restarts the machine with a planned reconfiguration reason.
func (WindowsResetter) Reboot(reason string) error {
	return winapi.Reboot(reason, winapi.ReasonPlannedReconfig)
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	return string(b)
}
