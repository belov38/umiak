package ops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"syscall"

	"github.com/belov38/umiak/services/node-agent/internal/lvm"
)

// Keep the base64 request comfortably below the forced-command's 1 MiB limit.
const transferBlockMax = 512 << 10

var transferIDRe = regexp.MustCompile(`^[a-f0-9]{32}$`)

type transferRange struct {
	Name     string `json:"name"`
	Offset   int64  `json:"offset"`
	Length   int    `json:"length"`
	HashOnly bool   `json:"hashOnly"`
}

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

func transferBounds(size uint64, offset int64, length int) error {
	if offset < 0 || length < 1 || length > transferBlockMax || uint64(offset) > size || uint64(length) > size-uint64(offset) {
		return badReq("invalid transfer range")
	}
	return nil
}

func (s *Server) lvTransferRead(ctx context.Context, raw json.RawMessage) (any, error) {
	var args transferRange
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	lv, err := s.transferTarget(ctx, args.Name)
	if err != nil {
		return nil, err
	}
	if err := transferBounds(lv.SizeBytes, args.Offset, args.Length); err != nil {
		return nil, err
	}
	release, err := s.activate(ctx, lv)
	if err != nil {
		return nil, err
	}
	defer release()
	open := s.ScanOpen
	if open == nil {
		open = openDevice
	}
	f, err := open(filepath.Join("/dev", s.Cfg.VG, args.Name))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	// Seek block devices instead of scanning every preceding block on every call.
	if seeker, ok := f.(io.Seeker); ok {
		if _, err = seeker.Seek(args.Offset, io.SeekStart); err != nil {
			return nil, err
		}
	} else if _, err = io.CopyN(io.Discard, f, args.Offset); err != nil {
		return nil, err
	}
	data := make([]byte, args.Length)
	if _, err = io.ReadFull(f, data); err != nil {
		return nil, err
	}
	hash := sha256.Sum256(data)
	result := map[string]any{"sha256": hex.EncodeToString(hash[:]), "zero": bytes.Equal(data, make([]byte, len(data))), "sizeBytes": lv.SizeBytes}
	if !args.HashOnly {
		result["data"] = base64.StdEncoding.EncodeToString(data)
	}
	return result, nil
}

// Prepare creates an unpublished snapshot-named LV. The transfer ID owns the
// staging LV; retries must match its size and origin. Published disks are never
// accepted by transferWrite. Promotion is a separate fenced worker operation.
func (s *Server) lvTransferPrepare(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		ID        string `json:"id"`
		Slot      string `json:"slot"`
		SizeBytes uint64 `json:"sizeBytes"`
		Base      string `json:"base"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	if !transferIDRe.MatchString(args.ID) || !regexp.MustCompile(`^[a-z0-9]{1,16}$`).MatchString(args.Slot) || args.SizeBytes == 0 || args.SizeBytes > 1<<50 || args.SizeBytes%512 != 0 {
		return nil, badReq("invalid transfer identity or size")
	}
	name := "umiak-snap-" + args.ID + "-" + args.Slot
	tag := "umiak-transfer-" + args.ID
	if args.Base != "" {
		if !baseRe.MatchString(args.Base) {
			return nil, forbidden("base must be a template")
		}
		base, err := s.transferTarget(ctx, args.Base)
		if err != nil {
			return nil, err
		}
		if base.SizeBytes != args.SizeBytes {
			return nil, badReq("base size mismatch")
		}
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, lv := range all {
		if lv.Name == name {
			if lv.SizeBytes != args.SizeBytes || lv.PoolLV != s.Cfg.ThinPool || lv.Origin != args.Base || !slices.Contains(lv.Tags, tag) || !ours(lv) || !slices.Contains(lv.Tags, "umiak-snap-"+args.ID) {
				return nil, forbidden("staging collision")
			}
			return map[string]any{"name": name}, nil
		}
	}
	tags := []string{"umiak", "umiak-snap-" + args.ID, tag}
	if args.Base != "" {
		err = s.LVM.CreateSnapshot(ctx, lvm.CreateSpec{Origin: args.Base, Name: name, Tags: tags})
	} else {
		cmd := []string{"-V", strconv.FormatUint(args.SizeBytes, 10) + "B", "-T", s.Cfg.VG + "/" + s.Cfg.ThinPool, "-n", name, "-kn"}
		for _, t := range tags {
			cmd = append(cmd, "--addtag", t)
		}
		_, err = s.Host.Run(ctx, "lvcreate", cmd...)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": name}, nil
}

func (s *Server) lvTransferWrite(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Name   string `json:"name"`
		Offset int64  `json:"offset"`
		Data   string `json:"data"`
		SHA256 string `json:"sha256"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	m := snapLVRe.FindStringSubmatch(args.Name)
	if m == nil || !transferIDRe.MatchString(m[1]) {
		return nil, forbidden("writes require a transfer staging volume")
	}
	lv, err := s.transferTarget(ctx, args.Name)
	if err != nil {
		return nil, err
	}
	if !ours(lv) || !slices.Contains(lv.Tags, "umiak-transfer-"+m[1]) {
		return nil, forbidden("volume is not transfer staging")
	}
	if len(args.Data) > base64.StdEncoding.EncodedLen(transferBlockMax) {
		return nil, badReq("block too large")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(args.Data)
	if err != nil {
		return nil, badReq("invalid block encoding")
	}
	if err := transferBounds(lv.SizeBytes, args.Offset, len(data)); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != args.SHA256 {
		return nil, badReq("block checksum mismatch")
	}
	// The open count catches an LV attached to a VM (including a boot in progress).
	// Staging volumes are not published to PVE until the worker verifies them.
	if len(lv.Attr) < 6 || lv.Attr[5] != '-' {
		return nil, forbidden("staging volume is open or its state is unknown")
	}
	release, err := s.activate(ctx, lv)
	if err != nil {
		return nil, err
	}
	defer release()
	open := s.TransferOpen
	if open == nil {
		open = func(path string) (*os.File, error) {
			return os.OpenFile(path, os.O_RDWR, 0) //nolint:gosec // path is constructed from the configured VG and validated staging LV
		}
	}
	f, err := open(filepath.Join("/dev", s.Cfg.VG, args.Name))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	// Serialize concurrent block replay across forced-command processes.
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return nil, err
	} //nolint:gosec // fd fits in int
	n, err := f.WriteAt(data, args.Offset)
	if err != nil {
		return nil, err
	}
	if n != len(data) {
		return nil, io.ErrShortWrite
	}
	if err = f.Sync(); err != nil {
		return nil, fmt.Errorf("sync block: %w", err)
	}
	return map[string]any{"sha256": args.SHA256, "writtenBytes": len(data)}, nil
}

// Digest executes beside the LV, so final verification never transfers the
// unchanged bytes through the control plane. It uses bounded memory.
func (s *Server) lvTransferDigest(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Name string `json:"name"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	lv, err := s.transferTarget(ctx, args.Name)
	if err != nil {
		return nil, err
	}
	if lv.SizeBytes == 0 || lv.SizeBytes > 8<<20 {
		return nil, badReq("digest RPC is limited to 8 MiB; use chunked transferRead hashes for larger disks")
	}
	release, err := s.activate(ctx, lv)
	if err != nil {
		return nil, err
	}
	defer release()
	open := s.ScanOpen
	if open == nil {
		open = openDevice
	}
	f, err := open(filepath.Join("/dev", s.Cfg.VG, args.Name))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	hash := sha256.New()
	if _, err = io.CopyN(hash, f, int64(lv.SizeBytes)); err != nil {
		return nil, err
	}
	return map[string]any{"sha256": hex.EncodeToString(hash.Sum(nil)), "sizeBytes": lv.SizeBytes}, nil
}
