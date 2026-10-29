package ops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"
)

var defaultSections = []string{"guests", "lvs", "hashes", "sysctl", "sbx0", "vmfiles", "journalReaders"}

func (s *Server) inventory(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Sections []string `json:"sections"`
		Search   string   `json:"search"`
		Since    int64    `json:"since"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	sections := args.Sections
	if len(sections) == 0 {
		sections = slices.Clone(defaultSections)
		if args.Search != "" {
			sections = append(sections, "search")
		}
	}
	out := map[string]any{}
	for _, sec := range sections {
		var (
			v   any
			err error
		)
		switch sec {
		case "guests":
			v, err = s.guests(ctx)
		case "lvs":
			v, err = s.foreignLVs(ctx)
		case "hashes":
			v, err = s.hashes()
		case "sysctl":
			v, err = s.sysctl()
		case "sbx0":
			v, err = s.vnetLinkLocal()
		case "vmfiles":
			v, err = s.vmFiles()
		case "journalReaders":
			v, err = s.journalReaders()
		case "search":
			if args.Search == "" {
				return nil, badReq("search section needs a search string")
			}
			v, err = s.search(ctx, args.Search, args.Since)
		default:
			return nil, badReq("unknown section %q", sec)
		}
		if err != nil {
			return nil, fmt.Errorf("inventory %s: %w", sec, err)
		}
		out[sec] = v
	}
	return out, nil
}

type qmRow struct {
	VMID       int    `json:"vmid"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	MemMB      string `json:"memMb"`
	BootDiskGB string `json:"bootDiskGb"`
	PID        string `json:"pid"`
}

type pctRow struct {
	VMID   int    `json:"vmid"`
	Status string `json:"status"`
	Lock   string `json:"lock"`
	Name   string `json:"name"`
}

func tableRows(out []byte) [][]string {
	var rows [][]string
	for line := range strings.Lines(string(out)) {
		f := strings.Fields(line)
		if len(f) == 0 || f[0] == "VMID" {
			continue
		}
		rows = append(rows, f)
	}
	return rows
}

func (s *Server) guests(ctx context.Context) (any, error) {
	qmOut, err := s.Host.Run(ctx, "qm", "list")
	if err != nil {
		return nil, err
	}
	pctOut, err := s.Host.Run(ctx, "pct", "list")
	if err != nil {
		return nil, err
	}
	qm := []qmRow{}
	for _, f := range tableRows(qmOut) {
		if len(f) < 6 {
			return nil, fmt.Errorf("unexpected qm list row %q", f)
		}
		id, _ := strconv.Atoi(f[0])
		qm = append(qm, qmRow{VMID: id, Name: f[1], Status: f[2], MemMB: f[3], BootDiskGB: f[4], PID: f[5]})
	}
	pct := []pctRow{}
	for _, f := range tableRows(pctOut) {
		id, _ := strconv.Atoi(f[0])
		switch len(f) {
		case 3:
			pct = append(pct, pctRow{VMID: id, Status: f[1], Name: f[2]})
		case 4:
			pct = append(pct, pctRow{VMID: id, Status: f[1], Lock: f[2], Name: f[3]})
		default:
			return nil, fmt.Errorf("unexpected pct list row %q", f)
		}
	}
	return map[string]any{"qm": qm, "pct": pct}, nil
}

func (s *Server) foreignLVs(ctx context.Context) (any, error) {
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	type row struct {
		Name      string `json:"name"`
		SizeBytes uint64 `json:"sizeBytes"`
		Attr      string `json:"attr"`
	}
	out := []row{}
	for _, l := range all {
		if !slices.Contains(l.Tags, "sbx") {
			out = append(out, row{l.Name, l.SizeBytes, l.Attr})
		}
	}
	return out, nil
}

func (s *Server) hashFile(dst map[string]string, p string) error {
	data, err := fs.ReadFile(s.Host.FS, p)
	if errors.Is(err, fs.ErrNotExist) {
		dst["/"+p] = "absent"
		return nil
	}
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	dst["/"+p] = hex.EncodeToString(sum[:])
	return nil
}

// vmidOfFile returns the VMID for "<vmid>.<ext>" file names, or -1.
func vmidOfFile(name string) int {
	base, _, _ := strings.Cut(name, ".")
	id, err := strconv.Atoi(base)
	if err != nil {
		return -1
	}
	return id
}

func (s *Server) hashes() (any, error) {
	h := map[string]string{}
	err := fs.WalkDir(s.Host.FS, "etc/pve/sdn", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		return s.hashFile(h, p)
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	fws, err := fs.Glob(s.Host.FS, "etc/pve/firewall/*.fw")
	if err != nil {
		return nil, err
	}
	for _, p := range fws {
		if s.Cfg.InRange(vmidOfFile(path.Base(p))) {
			continue
		}
		if err := s.hashFile(h, p); err != nil {
			return nil, err
		}
	}
	ifs, err := fs.Glob(s.Host.FS, "etc/network/interfaces.d/*")
	if err != nil {
		return nil, err
	}
	for _, p := range append([]string{"etc/pve/firewall/cluster.fw", "etc/pve/nodes/" + s.Cfg.Node + "/host.fw", "etc/network/interfaces"}, ifs...) {
		if err := s.hashFile(h, p); err != nil {
			return nil, err
		}
	}
	return h, nil
}

func (s *Server) sysctl() (any, error) {
	out := map[string]string{}
	for _, k := range []string{"net.ipv4.ip_forward", "net.ipv6.conf.all.forwarding"} {
		data, err := fs.ReadFile(s.Host.FS, "proc/sys/"+strings.ReplaceAll(k, ".", "/"))
		if err != nil {
			return nil, err
		}
		out[k] = strings.TrimSpace(string(data))
	}
	return out, nil
}

func (s *Server) vnetLinkLocal() (any, error) {
	data, err := fs.ReadFile(s.Host.FS, "proc/net/if_inet6")
	if err != nil {
		return nil, err
	}
	var addrs []string
	for line := range strings.Lines(string(data)) {
		f := strings.Fields(line)
		if len(f) != 6 || f[5] != s.Cfg.VNet || f[3] != "20" {
			continue
		}
		b, err := hex.DecodeString(f[0])
		if err != nil || len(b) != 16 {
			continue
		}
		addrs = append(addrs, netip.AddrFrom16([16]byte(b)).String())
	}
	res := map[string]any{"linkLocal": nil, "all": addrs}
	if len(addrs) > 0 {
		res["linkLocal"] = addrs[0]
	}
	return res, nil
}

func (s *Server) vmFiles() (any, error) {
	found := []string{}
	for id := s.Cfg.VMIDMin; id <= s.Cfg.VMIDMax; id++ {
		if !s.Cfg.InRange(id) {
			continue
		}
		for _, p := range []string{fmt.Sprintf("etc/pve/qemu-server/%d.conf", id), fmt.Sprintf("etc/pve/firewall/%d.fw", id)} {
			if _, err := fs.Stat(s.Host.FS, p); err == nil {
				found = append(found, "/"+p)
			}
		}
	}
	return found, nil
}

func (s *Server) journalReaders() (any, error) {
	data, err := fs.ReadFile(s.Host.FS, "etc/group")
	if err != nil {
		return nil, err
	}
	out := map[string][]string{"adm": {}, "systemd-journal": {}, "wheel": {}}
	for line := range strings.Lines(string(data)) {
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) != 4 {
			continue
		}
		if _, ok := out[f[0]]; ok && f[3] != "" {
			out[f[0]] = strings.Split(f[3], ",")
		}
	}
	return out, nil
}

// search reports only whether the needle was seen; the needle itself is never logged or returned.
func (s *Server) search(ctx context.Context, needle string, since int64) (any, error) {
	if since == 0 {
		since = s.Host.Now().Add(-time.Hour).Unix()
	}
	nb := []byte(needle)
	journal, err := s.Host.Run(ctx, "journalctl", "-q", "--no-pager", "-o", "cat", "--since", "@"+strconv.FormatInt(since, 10))
	if err != nil {
		return nil, err
	}
	res := map[string]bool{"journal": bytes.Contains(journal, nb), "tasklog": false, "qemuCmdline": false}

	sinceT := time.Unix(since, 0)
	err = fs.WalkDir(s.Host.FS, "var/log/pve/tasks", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || res["tasklog"] {
			return err
		}
		info, err := d.Info()
		if err != nil || info.ModTime().Before(sinceT) {
			return nil
		}
		data, err := fs.ReadFile(s.Host.FS, p)
		if err == nil && bytes.Contains(data, nb) {
			res["tasklog"] = true
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}

	cmdlines, err := fs.Glob(s.Host.FS, "proc/*/cmdline")
	if err != nil {
		return nil, err
	}
	for _, p := range cmdlines {
		data, err := fs.ReadFile(s.Host.FS, p)
		if err != nil {
			continue
		}
		argv0, _, _ := bytes.Cut(data, []byte{0})
		if !bytes.HasSuffix(argv0, []byte("kvm")) && !bytes.Contains(argv0, []byte("qemu-system")) {
			continue
		}
		if bytes.Contains(data, nb) {
			res["qemuCmdline"] = true
			break
		}
	}
	return res, nil
}
