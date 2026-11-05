package ops

import (
	"context"
	"github.com/belov38/umiak/services/node-agent/internal/lvm"
	"regexp"
	"slices"
)

var transferIDRe = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Only immutable bases and snapshots can be exported. VM disks must first be
// snapshotted by the lifecycle worker under its VM lock.
func (s *Server) transferTarget(ctx context.Context, name string) (lvm.LV, error) {
	if err := ValidOrigin(s.Cfg, name); err != nil {
		return lvm.LV{}, err
	}
	var need []string
	if baseRe.MatchString(name) {
		need = []string{"umiak-tpl"}
	} else if m := snapLVRe.FindStringSubmatch(name); m != nil {
		need = []string{"umiak", "umiak-snap-" + m[1]}
	} else {
		return lvm.LV{}, forbidden("transfer requires an immutable base or snapshot")
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return lvm.LV{}, err
	}
	for _, lv := range all {
		if lv.Name != name {
			continue
		}
		if len(lv.Attr) < 6 || lv.Attr[5] != '-' {
			return lvm.LV{}, forbidden("transfer device is open or its state is unknown")
		}
		if lv.PoolLV != s.Cfg.ThinPool {
			return lvm.LV{}, forbidden("wrong thin pool")
		}
		for _, tag := range need {
			if !slices.Contains(lv.Tags, tag) {
				return lvm.LV{}, forbidden("missing ownership tag")
			}
		}
		return lv, nil
	}
	return lvm.LV{}, forbidden("transfer volume is absent")
}
