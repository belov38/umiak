package ops

import (
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/belov38/boat-dev-clone/services/node-agent/internal/config"
)

var (
	// VMIDs are written without leading zeros: "vm-0598-disk-0" would parse as 598 but not match a
	// "base-598-" prefix check.
	lvNameRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9+_.-]{0,126}$`)
	baseRe     = regexp.MustCompile(`^base-([1-9][0-9]*)-[a-z0-9+_.-]+$`)
	vmAnyRe    = regexp.MustCompile(`^vm-([1-9][0-9]*)-[a-z0-9+_.-]+$`)
	vmDiskRe   = regexp.MustCompile(`^vm-([1-9][0-9]*)-disk-[0-9]+$`)
	mediaISORe = regexp.MustCompile(`^sbx-(seed|build|offline)-[a-z0-9-]{1,64}\.iso$|^sbx-virtio-win-[0-9]+\.[0-9]+\.[0-9]+\.iso$`)
	mediaImgRe = regexp.MustCompile(`^sbx-[a-z0-9.+_-]{1,96}\.(qcow2|img|raw)$`)
	snapLVRe   = regexp.MustCompile(`^sbx-snap-([a-z0-9]{1,32})-([a-z0-9]{1,16})$`)
	vmTagRe    = regexp.MustCompile(`^sbx-(vm|src)-([1-9][0-9]*)$`)
	snapTagRe  = regexp.MustCompile(`^sbx-snap-([a-z0-9]{1,32})$`)
	serialRe   = regexp.MustCompile(`^sbx1:[0-9a-fA-F-]{36}:[A-Za-z0-9_-]{43}$`)
	errBadName = errors.New("invalid LV name")
)

// ErrForbidden marks a request that is well-formed but outside the whitelist.
var ErrForbidden = errors.New("forbidden")

func forbidden(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrForbidden, fmt.Sprintf(format, args...))
}

func atoiMatch(m []string, i int) int {
	n, err := strconv.Atoi(m[i])
	if err != nil {
		return -1
	}
	return n
}

// ValidOrigin allows snapshots only of template disks (base-<id> of a template slot; lv.snapshot
// also requires the sbx-tpl tag), our snapshots and our VM disks.
func ValidOrigin(cfg config.Config, name string) error {
	if !lvNameRe.MatchString(name) {
		return errBadName
	}
	if m := baseRe.FindStringSubmatch(name); m != nil && cfg.IsTemplateSlot(atoiMatch(m, 1)) {
		return nil
	}
	if snapLVRe.MatchString(name) {
		return nil
	}
	if m := vmAnyRe.FindStringSubmatch(name); m != nil && cfg.InRange(atoiMatch(m, 1)) {
		return nil
	}
	return forbidden("origin %q is not ours", name)
}

// ValidTargetName allows only VM disks in our range and our snapshot names.
func ValidTargetName(cfg config.Config, name string) error {
	if !lvNameRe.MatchString(name) {
		return errBadName
	}
	if m := vmDiskRe.FindStringSubmatch(name); m != nil && cfg.InRange(atoiMatch(m, 1)) {
		return nil
	}
	if snapLVRe.MatchString(name) {
		return nil
	}
	return forbidden("target name %q is not allowed", name)
}

// ValidTags requires the "sbx" marker and allows only our tag shapes.
func ValidTags(cfg config.Config, tags []string) error {
	if !slices.Contains(tags, "sbx") {
		return forbidden("tag sbx is required")
	}
	for _, t := range tags {
		if t == "sbx" || snapTagRe.MatchString(t) {
			continue
		}
		if m := vmTagRe.FindStringSubmatch(t); m != nil && cfg.InRange(atoiMatch(m, 2)) {
			continue
		}
		return forbidden("tag %q is not allowed", t)
	}
	return nil
}

// SnapshotItem is one lvcreate -s in an lv.snapshot batch.
type SnapshotItem struct {
	Origin         string   `json:"origin"`
	Name           string   `json:"name"`
	Tags           []string `json:"tags"`
	ActivationSkip bool     `json:"activationSkip"`
}

// ValidSnapshotItem also requires the owner tag that cleanup relies on.
func ValidSnapshotItem(cfg config.Config, it SnapshotItem) error {
	if err := ValidOrigin(cfg, it.Origin); err != nil {
		return err
	}
	if err := ValidTargetName(cfg, it.Name); err != nil {
		return err
	}
	if err := ValidTags(cfg, it.Tags); err != nil {
		return err
	}
	var owner string
	if m := vmDiskRe.FindStringSubmatch(it.Name); m != nil {
		owner = "sbx-vm-" + m[1]
	} else if m := snapLVRe.FindStringSubmatch(it.Name); m != nil {
		owner = "sbx-snap-" + m[1]
	}
	if !slices.Contains(it.Tags, owner) {
		return forbidden("LV %q needs tag %q", it.Name, owner)
	}
	return nil
}

// ValidMAC accepts only MACs our allocator hands out (02:<cluster>:<vmid BE32>) and returns the VMID.
func ValidMAC(cfg config.Config, mac string) (int, error) {
	parts := strings.Split(strings.ToLower(mac), ":")
	if len(parts) != 6 {
		return 0, errors.New("invalid MAC")
	}
	b := make([]int, 6)
	for i, p := range parts {
		v, err := strconv.ParseUint(p, 16, 8)
		if err != nil || len(p) != 2 {
			return 0, errors.New("invalid MAC")
		}
		b[i] = int(v)
	}
	vmid := b[2]<<24 | b[3]<<16 | b[4]<<8 | b[5]
	// Template build VMs (template slots) get their MAC from the same allocator.
	if b[0] != 0x02 || b[1] != cfg.ClusterID || (!cfg.InRange(vmid) && !cfg.IsTemplateSlot(vmid)) {
		return 0, forbidden("MAC %s is not from our allocator", mac)
	}
	return vmid, nil
}

// ValidSearchNeedle allows only an S2 serial payload (raw or base64): the search would otherwise let
// the restricted key probe the root journal, task logs and QEMU command lines for arbitrary strings.
func ValidSearchNeedle(needle string) error {
	if serialRe.MatchString(needle) {
		return nil
	}
	if raw, err := base64.StdEncoding.DecodeString(needle); err == nil && serialRe.Match(raw) {
		return nil
	}
	return forbidden("search string must be an sbx1 serial payload")
}
