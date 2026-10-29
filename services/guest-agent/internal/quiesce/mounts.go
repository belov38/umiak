package quiesce

import (
	"bufio"
	"cmp"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
)

// freezableFS are the filesystem types the agent freezes (spec 14.2).
var freezableFS = map[string]bool{"ext4": true, "xfs": true, "btrfs": true}

// mountEntry is one line of /proc/self/mountinfo.
type mountEntry struct {
	Path, Source, FSType string
	// RO is set when the mount or the superblock is read-only.
	RO bool
}

// parseMountInfo parses the proc(5) mountinfo format:
//
//	36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw,errors=continue
//
// Escaped octal sequences (\040 and the like) in the mount point and the
// source are decoded.
func parseMountInfo(r io.Reader) ([]mountEntry, error) {
	var out []mountEntry
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		sep := slices.Index(fields, "-")
		if sep < 6 || len(fields) < sep+3 {
			return nil, fmt.Errorf("quiesce: mountinfo line %d: malformed", n)
		}
		e := mountEntry{
			Path:   unescapeMount(fields[4]),
			FSType: fields[sep+1],
			Source: unescapeMount(fields[sep+2]),
			RO:     hasOpt(fields[5], "ro"),
		}
		if len(fields) > sep+3 && hasOpt(fields[sep+3], "ro") {
			e.RO = true
		}
		out = append(out, e)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("quiesce: read mountinfo: %w", err)
	}
	return out, nil
}

// hasOpt reports whether the comma-separated option list opts holds opt.
func hasOpt(opts, opt string) bool {
	return slices.Contains(strings.Split(opts, ","), opt)
}

// unescapeMount decodes the \NNN octal escapes of mountinfo.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// selectMounts picks the mounts to freeze from the mountinfo entries:
// visible (not over-mounted at the same path), ext4, xfs or btrfs, not
// read-only, with a /dev/ source; one per source, since bind mounts and
// btrfs subvolumes share a superblock and a second FIFREEZE would fail with
// EBUSY. The shallowest mount point of a source names it. devOf maps a
// source to its device number; sources it cannot resolve are grouped by
// name. The result is in freeze order: deepest first.
func selectMounts(entries []mountEntry, devOf func(source string) (uint64, bool)) []Mount {
	// The last entry at a path hides the earlier ones.
	visible := make(map[string]int, len(entries))
	for i, e := range entries {
		visible[e.Path] = i
	}
	best := make(map[string]Mount)
	for i, e := range entries {
		if visible[e.Path] != i || e.RO || !freezableFS[e.FSType] || !strings.HasPrefix(e.Source, "/dev/") {
			continue
		}
		key := "src:" + e.Source
		if devOf != nil {
			if dev, ok := devOf(e.Source); ok {
				key = "dev:" + strconv.FormatUint(dev, 10)
			}
		}
		m := Mount{Path: e.Path, Source: e.Source, FSType: e.FSType}
		if cur, ok := best[key]; !ok || shallower(m.Path, cur.Path) {
			best[key] = m
		}
	}
	out := make([]Mount, 0, len(best))
	for _, m := range best {
		out = append(out, m)
	}
	slices.SortFunc(out, func(a, b Mount) int {
		if c := cmp.Compare(depth(b.Path), depth(a.Path)); c != 0 {
			return c
		}
		return cmp.Compare(a.Path, b.Path)
	})
	return out
}

// shallower reports whether path a is a better name than b: fewer
// components, then lexically smaller.
func shallower(a, b string) bool {
	if da, db := depth(a), depth(b); da != db {
		return da < db
	}
	return a < b
}

// depth is the number of components of an absolute path; "/" has 0.
func depth(p string) int {
	p = strings.Trim(p, "/")
	if p == "" {
		return 0
	}
	return strings.Count(p, "/") + 1
}
