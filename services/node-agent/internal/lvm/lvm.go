// Package lvm wraps the LVM command line tools used by sbx-node.
package lvm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// LV is one logical volume of the configured VG.
type LV struct {
	Name            string   `json:"name"`
	SizeBytes       uint64   `json:"sizeBytes"`
	Attr            string   `json:"attr"`
	Tags            []string `json:"tags"`
	Origin          string   `json:"origin,omitempty"`
	DataPercent     float64  `json:"dataPercent"`
	MetadataPercent float64  `json:"metadataPercent,omitempty"`
	PoolLV          string   `json:"poolLv,omitempty"`
}

// CreateSpec describes one thin snapshot.
type CreateSpec struct {
	Origin         string
	Name           string
	Tags           []string
	ActivationSkip bool
}

// LVM is what the operations need; tests use a fake.
type LVM interface {
	List(ctx context.Context) ([]LV, error)
	CreateSnapshot(ctx context.Context, s CreateSpec) error
	Remove(ctx context.Context, name string) error
	AutoextendThreshold(ctx context.Context) (int, error)
}

// Runner executes a command and returns its stdout.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// RunCommand runs a binary and includes stderr in the error.
func RunCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // callers pass fixed binaries and validated args
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// Exec implements LVM with the lvs/lvcreate/lvremove binaries.
type Exec struct {
	VG  string
	Run Runner
}

type lvsReport struct {
	Report []struct {
		LV []map[string]string `json:"lv"`
	} `json:"report"`
}

func parseFloat(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}

// List returns every LV of the VG.
func (e *Exec) List(ctx context.Context) ([]LV, error) {
	out, err := e.Run(ctx, "lvs", "--reportformat", "json", "--units", "b", "--nosuffix",
		"-o", "lv_name,lv_size,lv_attr,lv_tags,origin,data_percent,metadata_percent,pool_lv", e.VG)
	if err != nil {
		return nil, err
	}
	var rep lvsReport
	if err := json.Unmarshal(out, &rep); err != nil {
		return nil, fmt.Errorf("parse lvs: %w", err)
	}
	lvs := []LV{}
	for _, r := range rep.Report {
		for _, m := range r.LV {
			size, _ := strconv.ParseUint(strings.TrimSpace(m["lv_size"]), 10, 64)
			tags := []string{}
			if m["lv_tags"] != "" {
				tags = strings.Split(m["lv_tags"], ",")
			}
			lvs = append(lvs, LV{
				Name:            m["lv_name"],
				SizeBytes:       size,
				Attr:            m["lv_attr"],
				Tags:            tags,
				Origin:          m["origin"],
				DataPercent:     parseFloat(m["data_percent"]),
				MetadataPercent: parseFloat(m["metadata_percent"]),
				PoolLV:          m["pool_lv"],
			})
		}
	}
	return lvs, nil
}

// CreateSnapshot runs lvcreate -s for a thin snapshot.
func (e *Exec) CreateSnapshot(ctx context.Context, s CreateSpec) error {
	skip := "-kn"
	if s.ActivationSkip {
		skip = "-ky"
	}
	args := []string{"-s", skip, "-n", s.Name}
	for _, t := range s.Tags {
		args = append(args, "--addtag", t)
	}
	args = append(args, e.VG+"/"+s.Origin)
	_, err := e.Run(ctx, "lvcreate", args...)
	return err
}

// Remove runs lvremove for one LV.
func (e *Exec) Remove(ctx context.Context, name string) error {
	_, err := e.Run(ctx, "lvremove", "-y", e.VG+"/"+name)
	return err
}

// AutoextendThreshold reads activation/thin_pool_autoextend_threshold (100 means off).
func (e *Exec) AutoextendThreshold(ctx context.Context) (int, error) {
	out, err := e.Run(ctx, "lvmconfig", "--type", "full", "activation/thin_pool_autoextend_threshold")
	if err != nil {
		return 0, err
	}
	_, v, ok := strings.Cut(strings.TrimSpace(string(out)), "=")
	if !ok {
		return 0, fmt.Errorf("unexpected lvmconfig output %q", out)
	}
	return strconv.Atoi(v)
}
