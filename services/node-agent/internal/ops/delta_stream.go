package ops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"slices"
	"syscall"
)

const deltaFrameMax = 8 << 20
const deltaHeaderSize = 48
const deltaZero = 1
const deltaEnd = 2
const deltaPrefix = 4
const deltaAck = 8

type deltaArgs struct {
	Mode          string      `json:"mode"`
	Name          string      `json:"name"`
	SizeBytes     uint64      `json:"sizeBytes"`
	VerifiedBytes uint64      `json:"verifiedBytes"`
	BaseChecksum  string      `json:"baseChecksum"`
	Ranges        []byteRange `json:"ranges"`
}

func validateDelta(a deltaArgs) error {
	if a.Mode != "export" && a.Mode != "import" {
		return badReq("invalid delta mode")
	}
	if a.SizeBytes == 0 || a.SizeBytes > 1<<50 || a.SizeBytes%512 != 0 || a.VerifiedBytes > a.SizeBytes || (a.VerifiedBytes != a.SizeBytes && a.VerifiedBytes%(512<<10) != 0) {
		return badReq("invalid delta size/checkpoint")
	}
	if len(a.BaseChecksum) != 64 {
		return badReq("delta requires a verified identical base checksum")
	}
	if _, e := hex.DecodeString(a.BaseChecksum); e != nil {
		return badReq("invalid base checksum")
	}
	if len(a.Ranges) > 32768 {
		return badReq("too many delta ranges")
	}
	var end uint64
	for _, r := range a.Ranges {
		if r.Offset < end || r.Offset%(512<<10) != 0 || r.Length == 0 || r.Offset > a.SizeBytes || r.Length > a.SizeBytes-r.Offset || ((r.Offset+r.Length) != a.SizeBytes && r.Length%(512<<10) != 0) {
			return badReq("invalid/overlapping delta ranges")
		}
		end = r.Offset + r.Length
	}
	return nil
}
func deltaHash(h hash.Hash, b []byte, offset uint64) {
	for len(b) > 0 {
		n := min(len(b), 512<<10)
		sum := sha256.Sum256(b[:n])
		_, _ = fmt.Fprintf(h, "%d:%d:%x\n", offset, n, sum)
		offset += uint64(n)
		b = b[n:]
	}
}
func deltaHeader(offset uint64, length uint32, flags uint32, sum []byte) []byte {
	b := make([]byte, deltaHeaderSize)
	binary.BigEndian.PutUint64(b, offset)
	binary.BigEndian.PutUint32(b[8:], length)
	binary.BigEndian.PutUint32(b[12:], flags)
	copy(b[16:], sum)
	return b
}
func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, e := w.Write(b)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}

// DeltaStream holds one validated immutable source/staging device for one bounded
// binary session. No arbitrary device path, live VM or published write is allowed.
func (s *Server) DeltaStream(ctx context.Context, raw []byte, in io.Reader, out io.Writer) error {
	var a deltaArgs
	if e := decodeArgs(raw, &a); e != nil {
		return e
	}
	if e := validateDelta(a); e != nil {
		return e
	}
	lv, e := s.transferTarget(ctx, a.Name)
	if e != nil {
		return e
	}
	if lv.SizeBytes != a.SizeBytes {
		return badReq("delta device size changed")
	}
	writable := a.Mode == "import"
	if !writable {
		if e = s.freezeTransferSource(ctx, lv); e != nil {
			return e
		}
	}
	if writable {
		m := snapLVRe.FindStringSubmatch(a.Name)
		if m == nil || !transferIDRe.MatchString(m[1]) || !ours(lv) || !slices.Contains(lv.Tags, "umiak-transfer-"+m[1]) {
			return forbidden("delta writes require owned transfer staging")
		}
	}
	release, e := s.activate(ctx, lv)
	if e != nil {
		return e
	}
	defer release()
	flags := os.O_RDONLY
	if writable {
		flags = os.O_RDWR
	}
	var f *os.File
	if s.TransferOpen != nil {
		f, e = s.TransferOpen(filepath.Join("/dev", s.Cfg.VG, a.Name))
	} else {
		f, e = os.OpenFile(filepath.Join("/dev", s.Cfg.VG, a.Name), flags, 0)
	} //nolint:gosec // validated configured device only
	if e != nil {
		return e
	}
	defer func() { _ = f.Close() }()
	lock := syscall.LOCK_SH
	if writable {
		lock = syscall.LOCK_EX
	}
	if e = syscall.Flock(int(f.Fd()), lock|syscall.LOCK_NB); e != nil {
		return fmt.Errorf("delta device is already in use: %w", e)
	}
	h := sha256.New()
	_, _ = fmt.Fprintf(h, "umiak-block-tree-v1:%d:%d:%s\n", a.SizeBytes, 512<<10, a.BaseChecksum)
	data := make([]byte, deltaFrameMax)
	readback := make([]byte, deltaFrameMax)
	zeros := make([]byte, deltaFrameMax)
	for _, r := range a.Ranges {
		for offset := r.Offset; offset < r.Offset+r.Length; {
			if e = ctx.Err(); e != nil {
				return e
			}
			length := min(uint64(deltaFrameMax), r.Offset+r.Length-offset)
			prefix := offset < a.VerifiedBytes
			if prefix && offset+length > a.VerifiedBytes {
				length = a.VerifiedBytes - offset
			}
			b := data[:int(length)]
			var frameFlags uint32
			if prefix {
				frameFlags = deltaPrefix
			}
			if !writable {
				if _, e = f.ReadAt(b, int64(offset)); e != nil { //nolint:gosec // validateDelta bounds offsets to at most 1 PiB
					return e
				}
				sum := sha256.Sum256(b)
				if bytes.Equal(b, zeros[:len(b)]) {
					frameFlags |= deltaZero
				}
				if e = writeAll(out, deltaHeader(offset, uint32(length), frameFlags, sum[:])); e != nil {
					return e
				}
				if frameFlags&(deltaZero|deltaPrefix) == 0 {
					if e = writeAll(out, b); e != nil {
						return e
					}
				}
				deltaHash(h, b, offset)
			} else {
				head := make([]byte, deltaHeaderSize)
				if _, e = io.ReadFull(in, head); e != nil {
					return e
				}
				flags := binary.BigEndian.Uint32(head[12:])
				if binary.BigEndian.Uint64(head) != offset || binary.BigEndian.Uint32(head[8:]) != uint32(length) || flags&^(uint32(deltaZero|deltaPrefix)) != 0 || (flags&deltaPrefix != 0) != prefix {
					return badReq("invalid delta frame sequence/bounds")
				}
				if prefix {
					if _, e = f.ReadAt(b, int64(offset)); e != nil { //nolint:gosec // validateDelta bounds offsets to at most 1 PiB
						return e
					}
				} else {
					if flags&deltaZero != 0 {
						clear(b)
					} else if _, e = io.ReadFull(in, b); e != nil {
						return e
					}
				}
				sum := sha256.Sum256(b)
				if !bytes.Equal(sum[:], head[16:]) {
					return badReq("delta frame checksum/prefix mismatch")
				}
				if !prefix {
					n, err := f.WriteAt(b, int64(offset)) //nolint:gosec // validateDelta bounds offsets to at most 1 PiB
					if err != nil {
						return err
					}
					if n != len(b) {
						return io.ErrShortWrite
					}
					if e = f.Sync(); e != nil {
						return e
					}
					check := readback[:len(b)]
					if _, e = f.ReadAt(check, int64(offset)); e != nil { //nolint:gosec // validateDelta bounds offsets to at most 1 PiB
						return e
					}
					proof := sha256.Sum256(check)
					if proof != sum {
						return badReq("delta readback checksum mismatch")
					}
				}
				deltaHash(h, b, offset)
				if e = writeAll(out, deltaHeader(offset+length, uint32(length), deltaAck, sum[:])); e != nil {
					return e
				}
			}
			offset += length
		}
	}
	digest := h.Sum(nil)
	if !writable {
		return writeAll(out, deltaHeader(a.SizeBytes, 0, deltaEnd, digest))
	}
	head := make([]byte, deltaHeaderSize)
	if _, e = io.ReadFull(in, head); e != nil {
		return e
	}
	if binary.BigEndian.Uint64(head) != a.SizeBytes || binary.BigEndian.Uint32(head[8:]) != 0 || binary.BigEndian.Uint32(head[12:]) != deltaEnd || !bytes.Equal(head[16:], digest) {
		return badReq("delta final digest mismatch")
	}
	if e = f.Sync(); e != nil {
		return e
	}
	return writeAll(out, deltaHeader(a.SizeBytes, 0, deltaEnd|deltaAck, digest))
}
