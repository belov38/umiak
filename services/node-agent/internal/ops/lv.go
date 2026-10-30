package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/belov38/boat-dev-clone/services/node-agent/internal/lvm"
)

func (s *Server) lvSnapshot(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Items []SnapshotItem `json:"items"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	if len(args.Items) == 0 {
		return nil, badReq("items is empty")
	}
	for _, it := range args.Items {
		if err := ValidSnapshotItem(s.Cfg, it); err != nil {
			return nil, err
		}
	}
	// A vm-<id>-* or sbx-snap-<id>-* origin is trusted by its tags, not by its name: a non-sandbox
	// guest may use a VMID in our range, and anyone may name an LV sbx-snap-*.
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	byName := map[string]lvm.LV{}
	for _, l := range all {
		byName[l.Name] = l
	}
	// A template disk base-<id>-* protects its VMID: a new disk there would shadow the template.
	for _, it := range args.Items {
		m := vmDiskRe.FindStringSubmatch(it.Name)
		if m == nil {
			continue
		}
		prefix := "base-" + m[1] + "-"
		for name := range byName {
			if strings.HasPrefix(name, prefix) {
				return nil, forbidden("VMID %s belongs to template %q", m[1], name)
			}
		}
	}
	for _, it := range args.Items {
		var owner string
		if m := vmAnyRe.FindStringSubmatch(it.Origin); m != nil {
			owner = "sbx-vm-" + m[1]
		} else if m := snapLVRe.FindStringSubmatch(it.Origin); m != nil {
			owner = "sbx-snap-" + m[1]
		} else {
			continue
		}
		l, ok := byName[it.Origin]
		if !ok || !ours(l) || !slices.Contains(l.Tags, owner) {
			return nil, forbidden("origin %q is not a sandbox disk", it.Origin)
		}
	}
	created := []string{}
	for _, it := range args.Items {
		err := s.LVM.CreateSnapshot(ctx, lvm.CreateSpec{Origin: it.Origin, Name: it.Name, Tags: it.Tags, ActivationSkip: it.ActivationSkip})
		if err != nil {
			// Undo this call only; use a fresh context so a cancelled request still cleans up.
			var undoErrs []error
			for _, name := range slices.Backward(created) {
				if rerr := s.LVM.Remove(context.WithoutCancel(ctx), name); rerr != nil {
					undoErrs = append(undoErrs, rerr)
				}
			}
			return nil, errors.Join(fmt.Errorf("lvcreate %s: %w", it.Name, err), errors.Join(undoErrs...))
		}
		created = append(created, it.Name)
	}
	return map[string]any{"created": created}, nil
}

func ours(l lvm.LV) bool {
	return slices.Contains(l.Tags, "sbx") && !slices.Contains(l.Tags, "sbx-tpl")
}

func (s *Server) lvRemove(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Names []string `json:"names"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	byName := map[string]lvm.LV{}
	for _, l := range all {
		byName[l.Name] = l
	}
	removed, missing := []string{}, []string{}
	var todo []string
	for _, n := range args.Names {
		if !lvNameRe.MatchString(n) {
			return nil, errBadName
		}
		l, ok := byName[n]
		if !ok {
			missing = append(missing, n)
			continue
		}
		if !ours(l) {
			return nil, forbidden("LV %q is not tagged sbx", n)
		}
		todo = append(todo, n)
	}
	for _, n := range todo {
		if err := s.LVM.Remove(ctx, n); err != nil {
			return nil, fmt.Errorf("lvremove %s (removed so far %v): %w", n, removed, err)
		}
		removed = append(removed, n)
	}
	return map[string]any{"removed": removed, "missing": missing}, nil
}

func (s *Server) lvList(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Tags []string `json:"tags"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	out := []lvm.LV{}
	for _, l := range all {
		match := true
		for _, t := range args.Tags {
			if !slices.Contains(l.Tags, t) {
				match = false
				break
			}
		}
		if match {
			out = append(out, l)
		}
	}
	return map[string]any{"lvs": out}, nil
}

func (s *Server) poolUsage(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	res := map[string]any{}
	var count int
	var size, used uint64
	found := false
	for _, l := range all {
		if l.Name == s.Cfg.ThinPool {
			found = true
			res["dataPercent"] = l.DataPercent
			res["metadataPercent"] = l.MetadataPercent
			res["sizeBytes"] = l.SizeBytes
		}
		if ours(l) {
			count++
			size += l.SizeBytes
			used += uint64(float64(l.SizeBytes) * l.DataPercent / 100)
		}
	}
	if !found {
		return nil, fmt.Errorf("thin pool %s/%s not found", s.Cfg.VG, s.Cfg.ThinPool)
	}
	th, err := s.LVM.AutoextendThreshold(ctx)
	if err != nil {
		return nil, err
	}
	res["ourLvCount"] = count
	res["ourLvSizeBytes"] = size
	res["ourLvUsedBytes"] = used
	res["autoextendThreshold"] = th
	return res, nil
}
