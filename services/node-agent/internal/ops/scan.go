package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/belov38/umiak/services/node-agent/internal/lvm"
)

// lv.scan (S5 section 10): counts occurrences of secret patterns on a template or VM disk, on
// the host. The patterns (build secrets) never enter a guest and are never logged.

const (
	scanMaxPatterns = 64
	scanMinPattern  = 8
	scanMaxPattern  = 512
	scanChunk       = 4 << 20
)

// ScanOpener opens an LV device for reading; tests replace it.
type ScanOpener func(path string) (io.ReadCloser, error)

func openDevice(path string) (io.ReadCloser, error) {
	return os.Open(path) //nolint:gosec // the path is /dev/<vg>/<validated LV name>
}

// countPatterns reads r once and counts pattern occurrences, including across chunk borders.
// All-zero chunks (unallocated thin blocks) are skipped; no pattern is all zeros.
func countPatterns(r io.Reader, patterns [][]byte) (matches, scanned int64, err error) {
	longest := 0
	for _, p := range patterns {
		longest = max(longest, len(p))
	}
	buf := make([]byte, scanChunk+longest)
	zero := make([]byte, scanChunk)
	carry := 0
	for {
		n, rerr := io.ReadFull(r, buf[carry:carry+scanChunk])
		scanned += int64(n)
		window := buf[:carry+n]
		// New bytes all zero: no pattern (none contains a NUL) can end in them.
		if n > 0 && !bytes.Equal(buf[carry:carry+n], zero[:n]) {
			for _, p := range patterns {
				// Count only matches that end in the new bytes: the carried tail was counted.
				for off := 0; ; {
					i := bytes.Index(window[off:], p)
					if i < 0 {
						break
					}
					if off+i+len(p) > carry {
						matches++
					}
					off += i + 1
				}
			}
		}
		if errors.Is(rerr, io.EOF) || errors.Is(rerr, io.ErrUnexpectedEOF) {
			return matches, scanned, nil
		}
		if rerr != nil {
			return matches, scanned, rerr
		}
		keep := min(longest-1, len(window))
		copy(buf, window[len(window)-keep:])
		carry = keep
	}
}

// lvScan counts matches of the patterns on one LV: a template disk base-<id>-* or a VM disk
// vm-<id>-disk-N of the range. An inactive LV (a template) is activated for the scan and
// deactivated afterwards.
func (s *Server) lvScan(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Name     string   `json:"name"`
		Patterns []string `json:"patterns"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	lv, err := s.readTarget(ctx, args.Name)
	if err != nil {
		return nil, err
	}
	if len(args.Patterns) == 0 || len(args.Patterns) > scanMaxPatterns {
		return nil, badReq("patterns: 1 to %d required", scanMaxPatterns)
	}
	pats := make([][]byte, 0, len(args.Patterns))
	for _, p := range args.Patterns {
		if len(p) < scanMinPattern || len(p) > scanMaxPattern {
			return nil, badReq("patterns: each must be %d to %d bytes", scanMinPattern, scanMaxPattern)
		}
		if strings.ContainsRune(p, 0) {
			return nil, badReq("patterns: NUL bytes are not allowed")
		}
		pats = append(pats, []byte(p))
	}
	release, err := s.activate(ctx, lv)
	if err != nil {
		return nil, err
	}
	defer release()
	open := s.ScanOpen
	if open == nil {
		open = openDevice
	}
	f, err := open(filepath.Join("/dev", s.Cfg.VG, args.Name))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	matches, scanned, err := countPatterns(f, pats)
	if err != nil {
		return nil, fmt.Errorf("scan %s: %w", args.Name, err)
	}
	return map[string]any{"matches": matches, "scannedBytes": scanned}, nil
}

// activate makes a validated LV (readTarget) active for reading, a template's LV is inactive and
// skipped by default, and returns the function that restores its state.
func (s *Server) activate(ctx context.Context, l lvm.LV) (func(), error) {
	if len(l.Attr) > 4 && l.Attr[4] == 'a' {
		return func() {}, nil
	}
	lv := s.Cfg.VG + "/" + l.Name
	if _, err := s.Host.Run(ctx, "lvchange", "-ay", "-K", lv); err != nil {
		return nil, err
	}
	return func() {
		if _, err := s.Host.Run(context.WithoutCancel(ctx), "lvchange", "-an", lv); err != nil {
			s.Log(fmt.Sprintf("deactivating %s after a read: %v", lv, err))
		}
	}, nil
}

// lvUsage reports the thin usage of one LV (a template disk or a VM disk of the range); lvs
// reports no data percent for an inactive LV, so a template is activated for the reading.
func (s *Server) lvUsage(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Name string `json:"name"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	lv, err := s.readTarget(ctx, args.Name)
	if err != nil {
		return nil, err
	}
	release, err := s.activate(ctx, lv)
	if err != nil {
		return nil, err
	}
	defer release()
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(all, func(l lvm.LV) bool { return l.Name == args.Name })
	if i < 0 {
		return nil, forbidden("LV %q does not exist", args.Name)
	}
	// lvs reports no data percent (read as 0) for an inactive LV: never report that as empty.
	if len(all[i].Attr) <= 4 || all[i].Attr[4] != 'a' {
		return nil, fmt.Errorf("%s is not active, its usage is unknown", args.Name)
	}
	return map[string]any{"sizeBytes": all[i].SizeBytes, "dataPercent": all[i].DataPercent}, nil
}

// readTarget returns the LV that lv.scan and lv.usage may read: a template disk base-<id>-* of
// a template slot tagged umiak-tpl, or a sandbox disk vm-<id>-disk-N tagged umiak and umiak-vm-<id>.
// Names alone prove nothing (any guest may use a VMID or a base-* name), and dev infrastructure
// (590-596) is in neither range. Nothing is activated before this check.
func (s *Server) readTarget(ctx context.Context, name string) (lvm.LV, error) {
	if !lvNameRe.MatchString(name) {
		return lvm.LV{}, errBadName
	}
	var need []string
	if m := baseRe.FindStringSubmatch(name); m != nil && s.Cfg.IsTemplateSlot(atoiMatch(m, 1)) {
		need = []string{"umiak-tpl"}
	} else if m := vmDiskRe.FindStringSubmatch(name); m != nil && s.Cfg.InRange(atoiMatch(m, 1)) {
		need = []string{"umiak", "umiak-vm-" + m[1]}
	} else {
		return lvm.LV{}, forbidden("%q is not a template or sandbox disk", name)
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return lvm.LV{}, err
	}
	i := slices.IndexFunc(all, func(l lvm.LV) bool { return l.Name == name })
	if i < 0 {
		return lvm.LV{}, forbidden("LV %q does not exist", name)
	}
	for _, t := range need {
		if !slices.Contains(all[i].Tags, t) {
			return lvm.LV{}, forbidden("LV %q lacks tag %q", name, t)
		}
	}
	return all[i], nil
}
