package ops

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"slices"
	"strings"

	"github.com/belov38/umiak/services/node-agent/internal/lvm"
)

// Publish only clones a verified staging LV. It never replaces a destination
// and cannot write any existing VM disk. Worker fencing governs attachment.
func (s *Server) lvTransferPublish(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		Name   string `json:"name"`
		Target string `json:"target"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	m := snapLVRe.FindStringSubmatch(a.Name)
	t := vmDiskRe.FindStringSubmatch(a.Target)
	if m == nil || !transferIDRe.MatchString(m[1]) || t == nil {
		return nil, forbidden("invalid publication names")
	}
	lv, err := s.transferTarget(ctx, a.Name)
	if err != nil {
		return nil, err
	}
	proof := "umiak-transfer-" + m[1]
	if !ours(lv) || !slices.Contains(lv.Tags, proof) {
		return nil, forbidden("not transfer staging")
	}
	vmid := atoiMatch(t, 1)
	if !s.Cfg.IsTemplateSlot(vmid) {
		return nil, forbidden("publication requires a template slot")
	}
	conf, err := fs.ReadFile(s.Host.FS, fmt.Sprintf("etc/pve/qemu-server/%d.conf", vmid))
	if err != nil {
		return nil, err
	}
	marked := false
	for line := range strings.Lines(string(conf)) {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			break
		}
		k, v, _ := strings.Cut(line, ":")
		if strings.TrimSpace(k) == "tags" && slices.Contains(strings.FieldsFunc(strings.TrimSpace(v), func(r rune) bool { return r == ';' || r == ',' || r == ' ' }), "umiak-tpl") {
			marked = true
		}
	}
	if !marked {
		return nil, forbidden("template config lacks ownership tag")
	}
	tags := []string{"umiak-tpl", proof}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, item := range all {
		if item.Name == a.Target {
			if !slices.Contains(item.Tags, proof) {
				return nil, forbidden("publication collision")
			}
			return map[string]any{"name": a.Target}, nil
		}
	}
	if err := s.LVM.CreateSnapshot(ctx, lvm.CreateSpec{Origin: a.Name, Name: a.Target, Tags: tags}); err != nil {
		return nil, err
	}
	return map[string]any{"name": a.Target}, nil
}
