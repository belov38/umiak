package ops

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strings"

	"github.com/belov38/umiak/services/node-agent/internal/lvm"
)

// diskKeyRe matches the config keys of attached disks (not unusedN, not snapshot sections).
var diskKeyRe = regexp.MustCompile(`^(efidisk|tpmstate|scsi|sata|virtio|ide)[0-9]+$`)

// lv.adopt (S9): tags the disks Proxmox allocated for a sandbox VM (the fresh tpmstate0 of a
// Windows clone) with umiak and umiak-vm-<vmid>, so lv.snapshot, lv.remove and the tag-based cleanup
// treat them like the disks umiak-node cloned. Only a non-template VM in the sandbox range whose
// config carries the tag umiak qualifies, and only vm-<vmid>-disk-N volumes on our storage that the
// current config section attaches.
func (s *Server) lvAdopt(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		VMID int `json:"vmid"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	if !s.Cfg.InRange(args.VMID) {
		return nil, forbidden("VMID %d is not in the sandbox range", args.VMID)
	}
	conf, err := fs.ReadFile(s.Host.FS, fmt.Sprintf("etc/pve/qemu-server/%d.conf", args.VMID))
	if err != nil {
		return nil, forbidden("VM %d has no config: %v", args.VMID, err)
	}
	refs, ok := sandboxDisks(string(conf), s.Cfg.Storage, args.VMID)
	if !ok {
		return nil, forbidden("VM %d is a template or not tagged umiak", args.VMID)
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	byName := map[string]lvm.LV{}
	for _, l := range all {
		byName[l.Name] = l
	}
	owner := fmt.Sprintf("umiak-vm-%d", args.VMID)
	for _, name := range refs {
		if l, ok := byName[name]; ok && slices.Contains(l.Tags, "umiak-tpl") {
			return nil, forbidden("LV %q is a template disk", name)
		}
	}
	tagged, already := []string{}, []string{}
	for _, name := range refs {
		l, ok := byName[name]
		if !ok {
			continue
		}
		cmd := []string{}
		for _, t := range []string{"umiak", owner} {
			if !slices.Contains(l.Tags, t) {
				cmd = append(cmd, "--addtag", t)
			}
		}
		if len(cmd) == 0 {
			already = append(already, name)
			continue
		}
		if _, err := s.Host.Run(ctx, "lvchange", append(cmd, s.Cfg.VG+"/"+name)...); err != nil {
			return nil, fmt.Errorf("lvchange %s (tagged so far %v): %w", name, tagged, err)
		}
		tagged = append(tagged, name)
	}
	return map[string]any{"tagged": tagged, "already": already}, nil
}

// sandboxDisks reads the current section of a qemu-server config and returns the LV names of the
// disks it attaches from storage as vm-<vmid>-disk-N, in config order. ok is false for a template
// or a VM without the tag umiak.
func sandboxDisks(conf, storage string, vmid int) (names []string, ok bool) {
	own := regexp.MustCompile(fmt.Sprintf(`^vm-%d-disk-[0-9]+$`, vmid))
	template, tag := false, false
	for line := range strings.Lines(conf) {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		k, v, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch {
		case k == "template":
			template = v == "1"
		case k == "tags":
			tag = slices.Contains(strings.FieldsFunc(v, func(r rune) bool { return r == ';' || r == ',' || r == ' ' }), "umiak")
		case diskKeyRe.MatchString(k):
			volid, _, _ := strings.Cut(v, ",")
			st, name, found := strings.Cut(volid, ":")
			if found && st == storage && own.MatchString(name) && !slices.Contains(names, name) {
				names = append(names, name)
			}
		}
	}
	return names, tag && !template
}
