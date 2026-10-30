package ops

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strings"
)

// lv.tagTemplate (S5): adds the sbx-tpl tag to the disks of a template built by the S5 builder,
// as the runbook does for 599. Only a VM of a template slot whose Proxmox config says
// `template: 1` and carries the tag sbx-tpl qualifies; tagged disks become clone origins and
// lv.scan/lv.usage targets.
func (s *Server) lvTagTemplate(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		VMID int `json:"vmid"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	if !s.Cfg.IsTemplateSlot(args.VMID) {
		return nil, forbidden("VMID %d is not a template slot", args.VMID)
	}
	conf, err := fs.ReadFile(s.Host.FS, fmt.Sprintf("etc/pve/qemu-server/%d.conf", args.VMID))
	if err != nil {
		return nil, forbidden("VM %d has no config: %v", args.VMID, err)
	}
	if !isSbxTemplate(string(conf)) {
		return nil, forbidden("VM %d is not an sbx-tpl template", args.VMID)
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	disk := regexp.MustCompile(fmt.Sprintf(`^base-%d-disk-[0-9]+$`, args.VMID))
	tagged, already := []string{}, []string{}
	for _, l := range all {
		if !disk.MatchString(l.Name) {
			continue
		}
		if slices.Contains(l.Tags, "sbx-tpl") {
			already = append(already, l.Name)
			continue
		}
		if _, err := s.Host.Run(ctx, "lvchange", "--addtag", "sbx-tpl", s.Cfg.VG+"/"+l.Name); err != nil {
			return nil, err
		}
		tagged = append(tagged, l.Name)
	}
	if len(tagged)+len(already) == 0 {
		return nil, forbidden("VM %d has no base-%d-disk-N volumes", args.VMID, args.VMID)
	}
	return map[string]any{"tagged": tagged, "already": already}, nil
}

// isSbxTemplate reads the current section of a qemu-server config (snapshots follow in [name]
// sections) and requires `template: 1` and the tag sbx-tpl.
func isSbxTemplate(conf string) bool {
	template, tag := false, false
	for line := range strings.Lines(conf) {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "template":
			template = v == "1"
		case "tags":
			tag = slices.Contains(strings.FieldsFunc(v, func(r rune) bool { return r == ';' || r == ',' || r == ' ' }), "sbx-tpl")
		}
	}
	return template && tag
}
