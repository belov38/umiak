package ident

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// The Windows identity apply (S9 spec section 11.2). The orchestration here
// has no build tag so the darwin tests run it with FakeWinResetter; the
// system calls are behind WinResetter (reset_windows.go).

// ApplyMode says where ApplyWindows runs.
type ApplyMode int

const (
	// ModeSpecialize is the sysprep specialize pass: Windows Setup reboots
	// on its own afterwards, so no reboot is asked for.
	ModeSpecialize ApplyMode = iota
	// ModeEarly is the computer startup script (umiak-agent early) or a
	// manual `identity apply`.
	ModeEarly
	// ModeService is the agent service at start, a fallback for a startup
	// script that did not run.
	ModeService
)

func (m ApplyMode) String() string {
	switch m {
	case ModeSpecialize:
		return "specialize"
	case ModeEarly:
		return "early"
	case ModeService:
		return "service"
	}
	return fmt.Sprintf("ApplyMode(%d)", int(m))
}

const (
	// DefaultUser is the local account whose password a clone of the
	// template replaces (spec 8.2).
	DefaultUser = "user"
	// computerNamePrefix and the 12 hex digits make 15 characters, the
	// NetBIOS limit.
	computerNamePrefix = "UMI"
	// passwordLen is the length of the generated password of DefaultUser.
	passwordLen = 32
	// MaxRenameReboots bounds the reboots for a computer name that does not
	// take effect while the identity is unchanged.
	MaxRenameReboots = 2
)

// WinResetter performs the parts of a Windows identity reset that touch the
// running system rather than files.
type WinResetter interface {
	// SetMachineGUID sets HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid.
	SetMachineGUID(guid string) error
	// RegenerateHostKeys removes the SSH host keys, generates new ones and
	// gives them the ACL sshd requires.
	RegenerateHostKeys() error
	// SetComputerName sets the computer name; it takes effect after a reboot
	// (or at the end of the specialize pass).
	SetComputerName(name string) error
	// ActiveComputerName returns the computer name in effect now.
	ActiveComputerName() (string, error)
	// NewUserPassword sets a new random password for the local account user
	// and stores it where the agent and autologon read it.
	NewUserPassword(user string) error
	// WipeSecrets overwrites and removes the secrets directory.
	WipeSecrets() error
	// Reboot restarts the machine (planned, reason for the event log).
	Reboot(reason string) error
}

// WindowsComputerName returns UMI<last 12 hex digits of the machine id> in
// upper case, the computer name of a Windows machine.
func WindowsComputerName(machineID string) string {
	h := strings.ToUpper(strings.ReplaceAll(machineID, "-", ""))
	if len(h) > hostnameSuffixLen {
		h = h[len(h)-hostnameSuffixLen:]
	}
	return computerNamePrefix + h
}

// ApplyWindows makes the Windows machine state match id (spec 11.2) under
// the global identity mutex. If identity.json records the same machine id
// it changes nothing. Otherwise it wipes the agent state and the secrets,
// restores the template SSH CA keys, sets MachineGuid, the SSH host keys
// and the computer name, on the first boot after seal (no identity.json)
// sets a new password for DefaultUser, removes the sysprep answer file and
// writes identity.json with ResetPending as the last step, so an
// interrupted apply is repeated on the next boot.
//
// rebootNeeded reports that the active computer name differs from the
// machine's name outside the specialize pass, also when nothing else
// changed (an earlier apply whose reboot did not happen; the name is set
// again then). The caller reboots.
func ApplyWindows(ctx context.Context, l paths.Layout, id Identity, r WinResetter, mode ApplyMode) (changed, rebootNeeded bool, err error) {
	unlock, err := lockIdentity(ctx)
	if err != nil {
		return false, false, err
	}
	defer unlock()
	if err := SecureAgentDirs(l); err != nil {
		return false, false, err
	}
	return applyWindows(ctx, l, id, r, mode)
}

// applyWindows is ApplyWindows without the lock.
func applyWindows(ctx context.Context, l paths.Layout, id Identity, r WinResetter, mode ApplyMode) (changed, rebootNeeded bool, err error) {
	if err := ctx.Err(); err != nil {
		return false, false, err
	}
	hexID, ok := machineIDHex(id.MachineID)
	if !ok {
		return false, false, errors.New("ident: invalid machine id")
	}
	name := WindowsComputerName(hexID)

	old, err := LoadFile(l.IdentityFile)
	firstBoot := false
	switch {
	case err == nil:
		if oldHex, _ := machineIDHex(old.MachineID); oldHex == hexID {
			reboot, err := renameAgain(l, old, r, name, id.BootID, mode)
			return false, reboot, err
		}
	case errors.Is(err, fs.ErrNotExist):
		// Only a clone of the template has no identity.json. A fork or a
		// VM from a saved snapshot keeps the password (spec 11.2 step 5).
		firstBoot = true
	default:
		slog.Warn("identity.json is unreadable, treating the machine as a fork", "err", err)
	}
	if mode == ModeService {
		slog.Warn("the startup script did not apply the identity, applying it in the service")
	}

	if err := wipeState(l); err != nil {
		return false, false, err
	}
	if err := r.WipeSecrets(); err != nil {
		return false, false, fmt.Errorf("ident: wipe secrets: %w", err)
	}
	if err := restoreSSHUserCA(l); err != nil {
		return false, false, err
	}
	if err := r.SetMachineGUID(canonicalUUID(hexID)); err != nil {
		return false, false, fmt.Errorf("ident: set MachineGuid: %w", err)
	}
	if err := r.RegenerateHostKeys(); err != nil {
		return false, false, fmt.Errorf("ident: regenerate host keys: %w", err)
	}
	fps, err := hostKeyFingerprints(l.SSHDir)
	if err != nil {
		return false, false, err
	}
	if err := r.SetComputerName(name); err != nil {
		return false, false, fmt.Errorf("ident: set computer name: %w", err)
	}
	if firstBoot {
		if err := r.NewUserPassword(DefaultUser); err != nil {
			return false, false, fmt.Errorf("ident: new password of %s: %w", DefaultUser, err)
		}
	}
	if l.SysprepUnattend != "" {
		if err := os.Remove(l.SysprepUnattend); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return false, false, fmt.Errorf("ident: remove sysprep answer file: %w", err)
		}
	}
	reboot, rerr := needReboot(r, name, mode)
	f := &File{MachineID: id.MachineID, HostKeyFingerprints: fps, ResetPending: true}
	if rerr == nil && reboot {
		f.RebootBoot = id.BootID
	}
	if err := f.Save(l.IdentityFile); err != nil {
		return false, false, fmt.Errorf("ident: write identity.json: %w", err)
	}
	return true, reboot, rerr
}

// renameAgain handles an unchanged identity whose computer name is not in
// effect: the reboot of an earlier apply did not happen, or something
// renamed the machine since. It sets the name again (a reboot alone would
// not fix a foreign rename) and asks for a reboot, at most MaxRenameReboots
// times in a row, counted in identity.json; then it logs an error and
// stops rebooting. A name in effect resets the counter.
//
// A reboot asked for in this boot (bootID, recorded in identity.json) that
// has not happened yet is asked for again without counting: Windows can
// take minutes to act on it under load, and giving up in that boot would
// let the machine go ready and reboot later under its user.
func renameAgain(l paths.Layout, f *File, r WinResetter, name, bootID string, mode ApplyMode) (bool, error) {
	reboot, err := needReboot(r, name, mode)
	if err != nil {
		return false, err
	}
	if !reboot {
		if (f.RenameReboots != 0 || f.RebootBoot != "") && mode != ModeSpecialize {
			f.RenameReboots = 0
			f.RebootBoot = ""
			if err := f.Save(l.IdentityFile); err != nil {
				return false, fmt.Errorf("ident: write identity.json: %w", err)
			}
		}
		return false, nil
	}
	if bootID != "" && f.RebootBoot == bootID {
		slog.Warn("the reboot for the computer name asked for in this boot has not happened yet, asking again",
			"want", name, "boot_id", bootID)
		return true, nil
	}
	if f.RenameReboots >= MaxRenameReboots {
		slog.Error("the computer name does not take effect, no more reboots",
			"want", name, "reboots", f.RenameReboots)
		return false, nil
	}
	if err := r.SetComputerName(name); err != nil {
		return false, fmt.Errorf("ident: set computer name: %w", err)
	}
	f.RenameReboots++
	f.RebootBoot = bootID
	if err := f.Save(l.IdentityFile); err != nil {
		return false, fmt.Errorf("ident: write identity.json: %w", err)
	}
	return true, nil
}

// needReboot reports whether the active computer name differs from name
// outside the specialize pass.
func needReboot(r WinResetter, name string, mode ApplyMode) (bool, error) {
	if mode == ModeSpecialize {
		return false, nil
	}
	active, err := r.ActiveComputerName()
	if err != nil {
		return false, fmt.Errorf("ident: active computer name: %w", err)
	}
	return !strings.EqualFold(active, name), nil
}

// restoreSSHUserCA replaces the effective SSH CA keys with the template
// copy (empty if the template has none) and gives the file the ACL sshd
// requires.
func restoreSSHUserCA(l paths.Layout) error {
	ca, err := os.ReadFile(l.TemplateSSHCA)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("ident: read template ssh ca: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(l.SSHUserCA), 0o755); err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(l.SSHUserCA, ca, 0o644); err != nil {
		return fmt.Errorf("ident: write ssh user ca: %w", err)
	}
	if err := secureSSHFile(l.SSHUserCA); err != nil {
		return fmt.Errorf("ident: ssh user ca ACL: %w", err)
	}
	return nil
}

// canonicalUUID formats 32 lower-case hex digits as 8-4-4-4-12.
func canonicalUUID(h string) string {
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// Character classes of a generated password. Every class appears at least
// once so any local complexity policy is met.
var passwordClasses = []string{
	"ABCDEFGHJKLMNPQRSTUVWXYZ",
	"abcdefghijkmnopqrstuvwxyz",
	"23456789",
	"-_.:+=@%",
}

// newPassword returns passwordLen random ASCII characters with one of each
// class at a random position that do not contain the account name user
// (case-insensitive; the Windows complexity policy refuses that). The
// caller clears the slice after use.
func newPassword(user string) ([]byte, error) {
	for {
		pw, err := randomPassword()
		if err != nil {
			return nil, err
		}
		if !containsFold(pw, user) {
			return pw, nil
		}
		clear(pw)
	}
}

// randomPassword returns passwordLen random characters, one of each class
// at a random position.
func randomPassword() ([]byte, error) {
	all := strings.Join(passwordClasses, "")
	pw := make([]byte, passwordLen)
	for i := range pw {
		set := all
		if i < len(passwordClasses) {
			set = passwordClasses[i]
		}
		c, err := randIndex(len(set))
		if err != nil {
			clear(pw)
			return nil, err
		}
		pw[i] = set[c]
	}
	// Fisher-Yates, so the class characters are not always in front.
	for i := len(pw) - 1; i > 0; i-- {
		j, err := randIndex(i + 1)
		if err != nil {
			clear(pw)
			return nil, err
		}
		pw[i], pw[j] = pw[j], pw[i]
	}
	return pw, nil
}

// containsFold reports whether the ASCII bytes pw contain sub, ignoring
// case, without copying pw.
func containsFold(pw []byte, sub string) bool {
	if sub == "" {
		return false
	}
	for i := 0; i+len(sub) <= len(pw); i++ {
		if strings.EqualFold(sub, unsafeString(pw[i:i+len(sub)])) {
			return true
		}
	}
	return false
}

func randIndex(n int) (int, error) {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0, fmt.Errorf("ident: random: %w", err)
	}
	return int(v.Int64()), nil
}

// utf16LE encodes UTF-8 b as UTF-16LE without a terminator. It decodes b in
// place, so no other copy of a password is left behind.
func utf16LE(b []byte) []byte {
	out := make([]byte, 0, 2*len(b)) // never grows: no stale copies
	put := func(c rune) { out = append(out, byte(c), byte(c>>8)) }
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		b = b[n:]
		if r1, r2 := utf16.EncodeRune(r); r1 != unicode.ReplacementChar {
			put(r1)
			put(r2)
		} else {
			put(r)
		}
	}
	return out
}

// unsafeString views b as a string without copying it.
func unsafeString(b []byte) string {
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// FakeWinResetter records calls instead of changing the system. It is meant
// for tests.
type FakeWinResetter struct {
	// Calls lists the invoked methods in order, with the argument after a
	// space where there is one ("SetComputerName UMIAK...").
	Calls []string
	// Errs maps a method name to the error it returns.
	Errs map[string]error
	// Active is what ActiveComputerName returns.
	Active string
	// OnRegenerate, if set, runs inside RegenerateHostKeys.
	OnRegenerate func() error
}

var _ WinResetter = (*FakeWinResetter)(nil)

func (f *FakeWinResetter) record(call string) error {
	f.Calls = append(f.Calls, call)
	name, _, _ := strings.Cut(call, " ")
	return f.Errs[name]
}

// SetMachineGUID records the call.
func (f *FakeWinResetter) SetMachineGUID(guid string) error {
	return f.record("SetMachineGUID " + guid)
}

// RegenerateHostKeys records the call and runs OnRegenerate.
func (f *FakeWinResetter) RegenerateHostKeys() error {
	if err := f.record("RegenerateHostKeys"); err != nil {
		return err
	}
	if f.OnRegenerate != nil {
		return f.OnRegenerate()
	}
	return nil
}

// SetComputerName records the call. Active does not change: the name takes
// effect after a reboot.
func (f *FakeWinResetter) SetComputerName(name string) error {
	return f.record("SetComputerName " + name)
}

// ActiveComputerName records the call and returns Active.
func (f *FakeWinResetter) ActiveComputerName() (string, error) {
	if err := f.record("ActiveComputerName"); err != nil {
		return "", err
	}
	return f.Active, nil
}

// NewUserPassword records the call.
func (f *FakeWinResetter) NewUserPassword(user string) error {
	return f.record("NewUserPassword " + user)
}

// WipeSecrets records the call.
func (f *FakeWinResetter) WipeSecrets() error {
	return f.record("WipeSecrets")
}

// Reboot records the call.
func (f *FakeWinResetter) Reboot(reason string) error {
	return f.record("Reboot " + reason)
}
