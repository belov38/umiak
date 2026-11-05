package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type byteRange struct {
	Offset uint64 `json:"offset"`
	Length uint64 `json:"length"`
}

// thin_delta includes mappings removed from either side: right_only is a
// changed-to-zero range, not a hole that may be skipped when applying a delta.
func thinRanges(raw []byte, delta bool, size uint64) ([]byteRange, error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	var block uint64
	var ranges []byteRange
	for {
		token, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		e, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		attrs := map[string]string{}
		for _, a := range e.Attr {
			attrs[a.Name.Local] = a.Value
		}
		number := func(k string) (uint64, error) { return strconv.ParseUint(attrs[k], 10, 64) }
		if e.Name.Local == "superblock" {
			b, err := number("data_block_size")
			if err != nil || b == 0 || b > 1<<21 {
				return nil, fmt.Errorf("invalid metadata block size")
			}
			block = b * 512
			continue
		}
		var off, n uint64
		if delta {
			if e.Name.Local != "left_only" && e.Name.Local != "right_only" && e.Name.Local != "different" {
				continue
			}
			off, err = number("begin")
			if err == nil {
				n, err = number("length")
			}
		} else {
			switch e.Name.Local {
			case "range_mapping":
				off, err = number("origin_begin")
				if err == nil {
					n, err = number("length")
				}
			case "single_mapping":
				off, err = number("origin_block")
				n = 1
			default:
				continue
			}
		}
		if err != nil || block == 0 || n == 0 || off > size/block || n > (size-off*block+block-1)/block {
			return nil, fmt.Errorf("invalid metadata range")
		}
		length := min(n*block, size-off*block)
		ranges = append(ranges, byteRange{off * block, length})
	}
	if block == 0 {
		return nil, fmt.Errorf("missing metadata superblock")
	}
	return ranges, nil
}

// This RPC accepts LV names only. Device IDs, mapper paths and pool identity
// are derived from trusted LVM inventory, never supplied by the control plane.
func (s *Server) lvTransferMap(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Name  string `json:"name"`
		Base  string `json:"base"`
		After uint64 `json:"after"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	lv, err := s.transferTarget(ctx, args.Name)
	if err != nil {
		return nil, err
	}
	if lv.ThinID == "" {
		return nil, fmt.Errorf("thin device ID is unavailable")
	}
	cmd := []string{"--metadata-snap", "--dev-id", lv.ThinID}
	binary := "thin_dump"
	if args.Base != "" {
		base, err := s.transferTarget(ctx, args.Base)
		if err != nil {
			return nil, err
		}
		if base.ThinID == "" || base.SizeBytes != lv.SizeBytes {
			return nil, badReq("incompatible delta base")
		}
		binary = "thin_delta"
		cmd = []string{"--metadata-snap", "--thin1", lv.ThinID, "--thin2", base.ThinID}
	}
	mapper := func(s string) string { return strings.ReplaceAll(s, "-", "--") }
	pool := "/dev/mapper/" + mapper(s.Cfg.VG) + "-" + mapper(s.Cfg.ThinPool) + "-tpool"
	// A busy metadata snapshot belongs to another user; never release it. The
	// kernel serializes reservation across all node-agent processes and tools.
	if _, err = s.Host.Run(ctx, "dmsetup", "message", pool, "0", "reserve_metadata_snap"); err != nil {
		return nil, err
	}
	defer func() {
		if _, err := s.Host.Run(context.WithoutCancel(ctx), "dmsetup", "message", pool, "0", "release_metadata_snap"); err != nil {
			s.Log("release metadata snapshot: " + err.Error())
		}
	}()
	metadata := "/dev/mapper/" + mapper(s.Cfg.VG) + "-" + mapper(s.Cfg.ThinPool+"_tmeta")
	out, err := s.Host.Run(ctx, binary, append(cmd, metadata)...)
	if err != nil {
		return nil, err
	}
	ranges, err := thinRanges(out, args.Base != "", lv.SizeBytes)
	if err != nil {
		return nil, err
	}
	page := []byteRange{}
	var next uint64
	for _, r := range ranges {
		end := r.Offset + r.Length
		if end <= args.After {
			continue
		}
		if r.Offset < args.After {
			r.Length = end - args.After
			r.Offset = args.After
		}
		if len(page) == 4096 {
			next = r.Offset
			break
		}
		page = append(page, r)
	}
	return map[string]any{"ranges": page, "next": next, "sizeBytes": lv.SizeBytes}, nil
}
