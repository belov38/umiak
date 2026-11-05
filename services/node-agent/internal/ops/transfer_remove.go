package ops

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
)

var lvUUIDRe = regexp.MustCompile(`^[a-zA-Z0-9-]{6,64}$`)

// Select by immutable LVM UUID, so a stale cleanup can never delete a new LV
// that reused the same VMID/name after the old resource was removed.
func (s *Server) lvTransferRemove(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		Name string `json:"name"`
		UUID string `json:"uuid"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	if err := ValidTargetName(s.Cfg, a.Name); err != nil {
		return nil, err
	}
	if !lvUUIDRe.MatchString(a.UUID) {
		return nil, badReq("invalid LV UUID")
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, lv := range all {
		if lv.Name != a.Name {
			continue
		}
		if lv.UUID != a.UUID {
			return nil, forbidden("LV generation changed")
		}
		if !ours(lv) || lv.PoolLV != s.Cfg.ThinPool {
			return nil, forbidden("not an owned sandbox volume")
		}
		if len(lv.Attr) < 6 || lv.Attr[5] != '-' {
			return nil, forbidden("volume is open")
		}
		owner := ""
		if m := vmDiskRe.FindStringSubmatch(a.Name); m != nil {
			owner = "umiak-vm-" + m[1]
		} else if m := snapLVRe.FindStringSubmatch(a.Name); m != nil {
			owner = "umiak-snap-" + m[1]
		}
		if !slices.Contains(lv.Tags, owner) {
			return nil, forbidden("missing owner tag")
		}
		if _, err := s.Host.Run(ctx, "lvremove", "-y", "--select", "lv_uuid="+a.UUID, s.Cfg.VG); err != nil {
			return nil, err
		}
		return map[string]any{"removed": true}, nil
	}
	return map[string]any{"missing": true}, nil
}
