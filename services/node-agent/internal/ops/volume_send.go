package ops

// Full transfers use Proxmox's raw+size format and existing cluster SSH trust.
// Only metadata crosses the control plane; no shell/command is accepted from it.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/belov38/umiak/services/node-agent/internal/lvm"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// VolumeReceiveArgs is produced by the source agent, never a shell fragment.
type VolumeReceiveArgs struct {
	TargetName string `json:"targetName"`
	TargetVmid int    `json:"targetVmid"`
	SourceNode string `json:"sourceNode"`
	SourceUUID string `json:"sourceUUID"`
	SizeBytes  uint64 `json:"sizeBytes"`
	Probe      bool   `json:"probe,omitempty"`
	Restart    bool   `json:"restart,omitempty"`
}

// VolumeReceipt binds a complete import to immutable source and destination UUIDs.
type VolumeReceipt struct {
	Name           string  `json:"name"`
	SourceUUID     string  `json:"sourceUUID"`
	UUID           string  `json:"uuid"`
	SHA256         string  `json:"sha256"`
	Algorithm      string  `json:"algorithm"`
	SizeBytes      uint64  `json:"sizeBytes"`
	WireBytes      uint64  `json:"wireBytes"`
	ElapsedSeconds float64 `json:"elapsedSeconds"`
	Verified       bool    `json:"verified"`
}
type importRecord struct {
	Args    VolumeReceiveArgs `json:"args"`
	Receipt VolumeReceipt     `json:"receipt"`
}

// Bind the PVE storage alias to the same VG/thin pool whose LV ownership was checked.
func (s *Server) validateTransferStorage() error {
	raw, err := fs.ReadFile(s.Host.FS, "etc/pve/storage.cfg")
	if err != nil {
		return err
	}
	selected := false
	kind := ""
	values := map[string]string{}
	count := 0
	for _, line := range strings.Split(string(raw), "\n") {
		clean := strings.TrimSpace(line)
		if clean == "" || strings.HasPrefix(clean, "#") {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' {
			parts := strings.Fields(clean)
			selected = len(parts) == 2 && parts[1] == s.Cfg.Storage
			if selected {
				count++
				kind = strings.TrimSuffix(parts[0], ":")
			}
			continue
		}
		if selected {
			parts := strings.Fields(clean)
			if len(parts) >= 2 {
				values[parts[0]] = parts[1]
			}
		}
	}
	if count != 1 || kind != "lvmthin" || values["vgname"] != s.Cfg.VG || values["thinpool"] != s.Cfg.ThinPool {
		return forbidden("PVE storage does not match the configured Umiak VG/thin pool")
	}
	return nil
}
func (s *Server) clusterIP(name string) (string, error) {
	if !nodeNameRe.MatchString(name) {
		return "", badReq("invalid cluster node")
	}
	raw, err := fs.ReadFile(s.Host.FS, "etc/pve/.members")
	if err != nil {
		return "", err
	}
	var members struct {
		Nodes map[string]struct {
			Online int    `json:"online"`
			IP     string `json:"ip"`
		} `json:"nodelist"`
	}
	if err = json.Unmarshal(raw, &members); err != nil {
		return "", err
	}
	n, ok := members.Nodes[name]
	if !ok || n.Online != 1 || net.ParseIP(n.IP) == nil {
		return "", forbidden("target/source is not an online cluster member")
	}
	return n.IP, nil
}
func (s *Server) validateReceive(a VolumeReceiveArgs) (string, string, error) {
	m := snapLVRe.FindStringSubmatch(a.TargetName)
	if m == nil || !transferIDRe.MatchString(m[1]) || !regexp.MustCompile(`^[a-z0-9]{1,16}$`).MatchString(m[2]) {
		return "", "", badReq("invalid Umiak staging name")
	}
	if !s.Cfg.IsTemplateSlot(a.TargetVmid) || a.TargetVmid == 590 {
		return "", "", forbidden("target VMID outside Umiak ranges")
	}
	if !lvUUIDRe.MatchString(a.SourceUUID) || a.SizeBytes == 0 || a.SizeBytes > 1<<50 || a.SizeBytes%512 != 0 || !storageNameRe.MatchString(s.Cfg.Storage) {
		return "", "", badReq("invalid volume identity/size/storage")
	}
	if a.SourceNode == s.Cfg.Node {
		return "", "", badReq("source and destination are the same node")
	}
	if _, err := s.clusterIP(a.SourceNode); err != nil {
		return "", "", err
	}
	if err := s.validateTransferStorage(); err != nil {
		return "", "", err
	}
	return m[1], m[2], nil
}
func clusterCommand(ctx context.Context, node, ip string, a VolumeReceiveArgs) *exec.Cmd {
	raw, _ := json.Marshal(a)
	// Base64 is an argument with a restricted alphabet, not caller-provided shell text.
	command := "/usr/local/bin/umiak-node --receive-volume " + base64.RawStdEncoding.EncodeToString(raw)
	return exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlias="+node, "-o", "UserKnownHostsFile=/etc/pve/nodes/"+node+"/ssh_known_hosts", "-o", "ConnectTimeout=15", "root@"+ip, command) //nolint:gosec // fixed executable/options, validated member and encoded typed metadata
}

// boundedLog retains diagnostics only, never the binary data stream.
type boundedLog struct{ b []byte }

func (b *boundedLog) Write(p []byte) (int, error) {
	n := len(p)
	b.b = append(b.b, p...)
	if len(b.b) > 16384 {
		b.b = b.b[len(b.b)-16384:]
	}
	return n, nil
}
func (b *boundedLog) String() string { return string(b.b) }

type countWriter struct {
	w io.Writer
	n atomic.Uint64
}

func (w *countWriter) Write(p []byte) (int, error) {
	n, e := w.w.Write(p)
	if n > 0 {
		w.n.Add(uint64(n))
	}
	return n, e
}

type progressWriter struct {
	s       *Server
	n       uint64
	total   uint64
	last    time.Time
	started time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.n += uint64(len(b))
	if time.Since(p.last) >= time.Second && p.s.Progress != nil {
		p.last = time.Now()
		if err := p.s.Progress(map[string]any{"verifiedBytes": uint64(0), "processedBytes": min(p.n, p.total), "totalBytes": p.total, "elapsedSeconds": time.Since(p.started).Seconds()}); err != nil {
			return 0, err
		}
	}
	return len(b), nil
}

func (s *Server) volumeSendTo(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		Volume     string `json:"volume"`
		TargetNode string `json:"targetNode"`
		TargetName string `json:"targetName"`
		TargetVmid int    `json:"targetVmid"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	storage, name, ok := strings.Cut(a.Volume, ":")
	if !ok || storage != s.Cfg.Storage || !baseRe.MatchString(name) {
		return nil, forbidden("source storage is not configured Umiak storage")
	}
	lv, err := s.transferTarget(ctx, name)
	if err != nil {
		return nil, err
	}
	if !lvUUIDRe.MatchString(lv.UUID) {
		return nil, forbidden("source LV UUID unavailable")
	}
	ip, err := s.clusterIP(a.TargetNode)
	if err != nil {
		return nil, err
	}
	if a.TargetNode == s.Cfg.Node {
		return nil, badReq("same source and target")
	}
	receive := VolumeReceiveArgs{TargetName: a.TargetName, TargetVmid: a.TargetVmid, SourceNode: s.Cfg.Node, SourceUUID: lv.UUID, SizeBytes: lv.SizeBytes, Restart: len(lv.Attr) < 2 || lv.Attr[1] != 'r'}
	// Validate all destination syntax locally too; the destination validates its own ranges.
	m := snapLVRe.FindStringSubmatch(a.TargetName)
	if m == nil || !transferIDRe.MatchString(m[1]) || !regexp.MustCompile(`^[a-z0-9]{1,16}$`).MatchString(m[2]) {
		return nil, badReq("invalid staging destination")
	}
	if err = s.validateTransferStorage(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	probe := receive
	probe.Probe = true
	p := clusterCommand(ctx, a.TargetNode, ip, probe)
	var probeLog boundedLog
	p.Stderr = &probeLog
	out, err := p.Output()
	if err != nil {
		return nil, fmt.Errorf("target preflight: %w: %s", err, probeLog.String())
	}
	var prior struct {
		OK     bool          `json:"ok"`
		Result VolumeReceipt `json:"result"`
		Error  *Error        `json:"error"`
	}
	if err = json.Unmarshal(out, &prior); err != nil {
		return nil, fmt.Errorf("invalid target receipt: %w", err)
	}
	if !prior.OK {
		return nil, fmt.Errorf("target preflight refused: %v", prior.Error)
	}
	if err = requireReadOnlyTemplate(lv); err != nil {
		return nil, err
	}
	if prior.Result.Verified && prior.Result.SourceUUID == lv.UUID && prior.Result.SizeBytes == lv.SizeBytes {
		return prior.Result, nil
	}
	release, err := s.activate(ctx, lv)
	if err != nil {
		return nil, err
	}
	defer release()
	started := time.Now()
	remote := clusterCommand(ctx, a.TargetNode, ip, receive)
	var remoteOut bytes.Buffer
	var remoteLog boundedLog
	remote.Stdout = &remoteOut
	remote.Stderr = &remoteLog
	input, err := remote.StdinPipe()
	if err != nil {
		return nil, err
	}
	wire := &countWriter{w: input}
	compressor := exec.CommandContext(ctx, "zstd", "-1", "-q", "-c")
	compressor.Stdout = wire
	var compLog boundedLog
	compressor.Stderr = &compLog
	zin, err := compressor.StdinPipe()
	if err != nil {
		return nil, err
	}
	exporter := exec.CommandContext(ctx, "pvesm", "export", a.Volume, "raw+size", "-", "--with-snapshots", "0") //nolint:gosec // fixed executables; storage, owned LV and staging identifiers validated above
	var exportLog boundedLog
	exporter.Stderr = &exportLog
	exported, err := exporter.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = remote.Start(); err != nil {
		return nil, err
	}
	if err = compressor.Start(); err != nil {
		cancel()
		_ = remote.Wait()
		return nil, err
	}
	if err = exporter.Start(); err != nil {
		cancel()
		_ = compressor.Wait()
		_ = remote.Wait()
		return nil, err
	}
	var reader io.Reader = exported
	hash := sha256.New()
	progress := &progressWriter{s: s, total: lv.SizeBytes, started: started}
	n, copyErr := io.CopyBuffer(zin, io.TeeReader(reader, io.MultiWriter(hash, progress)), make([]byte, 8<<20))
	_ = zin.Close()
	if copyErr != nil || uint64(n) != lv.SizeBytes+8 { //nolint:gosec // io.Copy counts are nonnegative and volume sizes bounded by validation
		cancel()
	}
	exportErr := exporter.Wait()
	zipErr := compressor.Wait()
	_ = input.Close()
	sshErr := remote.Wait()
	if copyErr != nil {
		return nil, copyErr
	}
	if uint64(n) != lv.SizeBytes+8 { //nolint:gosec // io.Copy counts are nonnegative and volume sizes bounded by validation
		return nil, fmt.Errorf("truncated source export")
	}
	if exportErr != nil || zipErr != nil || sshErr != nil {
		return nil, fmt.Errorf("full volume stream failed: %w: %s %s %s", errors.Join(exportErr, zipErr, sshErr), exportLog.String(), compLog.String(), remoteLog.String())
	}
	var reply struct {
		OK     bool          `json:"ok"`
		Result VolumeReceipt `json:"result"`
		Error  *Error        `json:"error"`
	}
	if err = json.Unmarshal(remoteOut.Bytes(), &reply); err != nil {
		return nil, fmt.Errorf("invalid import receipt: %w", err)
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if !reply.OK || !reply.Result.Verified || reply.Result.SHA256 != digest || reply.Result.SizeBytes != lv.SizeBytes || reply.Result.SourceUUID != lv.UUID {
		return nil, fmt.Errorf("in-stream source/target checksum mismatch")
	}
	reply.Result.WireBytes = wire.n.Load()
	reply.Result.ElapsedSeconds = time.Since(started).Seconds()
	return reply.Result, nil
}

// ReceiveVolume is reachable only through the fixed cluster-root helper flag,
// not through the control-plane operation whitelist. It never accepts a path,
// executable, SSH address or command from a caller.
func (s *Server) ReceiveVolume(ctx context.Context, raw []byte, compressed io.Reader) (VolumeReceipt, error) {
	var a VolumeReceiveArgs
	var empty VolumeReceipt
	if err := decodeArgs(raw, &a); err != nil {
		return empty, err
	}
	if a.TargetVmid == 0 {
		a.TargetVmid = s.Cfg.VMIDMin
	}
	id, slot, err := s.validateReceive(a)
	if err != nil {
		return empty, err
	}
	dir := filepath.Join(s.Cfg.StateDir, "volume-imports")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return empty, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, id+"-"+slot+".lock"), os.O_CREATE|os.O_RDWR, 0600) //nolint:gosec // root-owned state directory, validated hex transfer ID and slot
	if err != nil {
		return empty, err
	}
	defer func() { _ = lock.Close() }()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return empty, fmt.Errorf("volume import is already running")
	}
	marker := filepath.Join(dir, id+"-"+slot+".json")
	interim := fmt.Sprintf("vm-%d-umiak-import-%s-%s", a.TargetVmid, id, slot)
	var old importRecord
	existing, readErr := os.ReadFile(marker) //nolint:gosec // root-owned state directory, validated hex transfer ID and slot
	if readErr == nil {
		if err = json.Unmarshal(existing, &old); err != nil {
			return empty, err
		}
		if old.Args.TargetName != a.TargetName || old.Args.TargetVmid != a.TargetVmid || old.Args.SourceUUID != a.SourceUUID || old.Args.SourceNode != a.SourceNode || old.Args.SizeBytes != a.SizeBytes {
			return empty, forbidden("import identity collision")
		}
	} else if !os.IsNotExist(readErr) {
		return empty, readErr
	}
	all, err := s.LVM.List(ctx)
	if err != nil {
		return empty, err
	}
	for _, lv := range all {
		if !a.Restart && lv.Name == a.TargetName && old.Receipt.Verified && ours(lv) && lv.PoolLV == s.Cfg.ThinPool && len(lv.Attr) >= 6 && lv.Attr[5] == '-' && slices.Contains(lv.Tags, "umiak-snap-"+id) && lv.UUID == old.Receipt.UUID && slices.Contains(lv.Tags, "umiak-transfer-"+id) && lv.SizeBytes == a.SizeBytes {
			return old.Receipt, nil
		}
	}
	if a.Probe {
		return empty, nil
	}
	for _, lv := range all {
		if lv.Name != interim && lv.Name != a.TargetName {
			continue
		}
		if readErr != nil || lv.PoolLV != s.Cfg.ThinPool || len(lv.Attr) < 6 || lv.Attr[5] != '-' {
			return empty, forbidden("existing import volume ownership/open state cannot be proved")
		}
		if lv.Name == a.TargetName && (!ours(lv) || !slices.Contains(lv.Tags, "umiak-transfer-"+id)) {
			return empty, forbidden("staging collision")
		}
		if old.Receipt.UUID != "" && lv.Name == a.TargetName && lv.UUID != old.Receipt.UUID {
			return empty, forbidden("import generation changed")
		}
		if err = s.LVM.Remove(ctx, lv.Name); err != nil {
			return empty, err
		}
	}
	record := importRecord{Args: a}
	save := func() error {
		b, e := json.Marshal(record)
		if e != nil {
			return e
		}
		temp := marker + ".new"
		if e = os.WriteFile(temp, b, 0600); e != nil {
			return e
		}
		if e = os.Rename(temp, marker); e != nil {
			return e
		}
		f, e := os.OpenFile(marker, os.O_RDWR, 0) //nolint:gosec // root-owned state directory, validated hex transfer ID and slot
		if e != nil {
			return e
		}
		e = f.Sync()
		_ = f.Close()
		if e != nil {
			return e
		}
		d, e := os.Open(dir) //nolint:gosec // operator-configured root-owned state directory
		if e != nil {
			return e
		}
		defer func() { _ = d.Close() }()
		return d.Sync()
	}
	if err = save(); err != nil {
		return empty, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	unzip := exec.CommandContext(ctx, "zstd", "-d", "-q", "-c")
	unzip.Stdin = compressed
	var unzipLog boundedLog
	unzip.Stderr = &unzipLog
	decoded, err := unzip.StdoutPipe()
	if err != nil {
		return empty, err
	}
	if err = unzip.Start(); err != nil {
		return empty, err
	}
	header := make([]byte, 8)
	if _, err = io.ReadFull(decoded, header); err != nil {
		cancel()
		_ = unzip.Wait()
		return empty, err
	}
	if binary.LittleEndian.Uint64(header) != a.SizeBytes {
		cancel()
		_ = unzip.Wait()
		return empty, badReq("raw+size header mismatch")
	}
	importer := exec.CommandContext(ctx, "pvesm", "import", s.Cfg.Storage+":"+interim, "raw+size", "-") //nolint:gosec // fixed executables; storage, owned LV and staging identifiers validated above
	var importLog boundedLog
	importer.Stdout = &importLog
	importer.Stderr = &importLog
	input, err := importer.StdinPipe()
	if err != nil {
		cancel()
		_ = unzip.Wait()
		return empty, err
	}
	if err = importer.Start(); err != nil {
		cancel()
		_ = unzip.Wait()
		return empty, err
	}
	hash := sha256.New()
	reader := io.TeeReader(io.MultiReader(bytes.NewReader(header), decoded), hash)
	n, copyErr := io.CopyBuffer(input, io.LimitReader(reader, int64(a.SizeBytes)+9), make([]byte, 8<<20)) //nolint:gosec // validateReceive limits size to 1 PiB
	_ = input.Close()
	if copyErr != nil || uint64(n) != a.SizeBytes+8 { //nolint:gosec // io.Copy counts are nonnegative and volume sizes bounded by validation
		cancel()
	}
	importErr := importer.Wait()
	unzipErr := unzip.Wait()
	if copyErr != nil {
		return empty, copyErr
	}
	if uint64(n) != a.SizeBytes+8 || importErr != nil || unzipErr != nil { //nolint:gosec // io.Copy counts are nonnegative and volume sizes bounded by validation
		return empty, fmt.Errorf("incomplete import: bytes=%d: %w: %s %s", n, errors.Join(importErr, unzipErr, io.ErrUnexpectedEOF), importLog.String(), unzipLog.String())
	}
	f, err := os.OpenFile(filepath.Join("/dev", s.Cfg.VG, interim), os.O_RDWR, 0) //nolint:gosec // configured VG and strictly validated import name
	if err != nil {
		return empty, err
	}
	err = f.Sync()
	_ = f.Close()
	if err != nil {
		return empty, err
	}
	if _, err = s.Host.Run(ctx, "lvchange", "--addtag", "umiak", "--addtag", "umiak-snap-"+id, "--addtag", "umiak-transfer-"+id, s.Cfg.VG+"/"+interim); err != nil {
		return empty, err
	}
	if _, err = s.Host.Run(ctx, "lvrename", s.Cfg.VG, interim, a.TargetName); err != nil {
		return empty, err
	}
	all, err = s.LVM.List(ctx)
	if err != nil {
		return empty, err
	}
	for _, lv := range all {
		if lv.Name == a.TargetName && lv.SizeBytes == a.SizeBytes && lvUUIDRe.MatchString(lv.UUID) && lv.PoolLV == s.Cfg.ThinPool && slices.Contains(lv.Tags, "umiak-transfer-"+id) {
			record.Receipt = VolumeReceipt{Name: a.TargetName, SourceUUID: a.SourceUUID, UUID: lv.UUID, SHA256: hex.EncodeToString(hash.Sum(nil)), Algorithm: "sha256-pvesm-raw+size-v1", SizeBytes: a.SizeBytes, Verified: true}
			if err = save(); err != nil {
				return empty, err
			}
			return record.Receipt, nil
		}
	}
	return empty, fmt.Errorf("imported staging LV identity unavailable")
}

// Cleanup an interrupted standard import using its root-owned durable marker.
// Ordinary volumes and a different LV generation can never match this proof.
func (s *Server) volumeCleanupImport(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		Name    string `json:"name"`
		Inspect bool   `json:"inspect,omitempty"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	m := snapLVRe.FindStringSubmatch(a.Name)
	if m == nil || !transferIDRe.MatchString(m[1]) || !regexp.MustCompile(`^[a-z0-9]{1,16}$`).MatchString(m[2]) {
		return nil, badReq("invalid import staging name")
	}
	dir := filepath.Join(s.Cfg.StateDir, "volume-imports")
	marker := filepath.Join(dir, m[1]+"-"+m[2]+".json")
	rawMarker, err := os.ReadFile(marker) //nolint:gosec // root-owned state directory, validated hex transfer ID and slot
	if os.IsNotExist(err) {
		return map[string]any{"missing": true}, nil
	}
	if err != nil {
		return nil, err
	}
	var record importRecord
	if err = json.Unmarshal(rawMarker, &record); err != nil {
		return nil, err
	}
	if record.Args.TargetName != a.Name {
		return nil, forbidden("import marker mismatch")
	}
	lock, err := os.OpenFile(filepath.Join(dir, m[1]+"-"+m[2]+".lock"), os.O_CREATE|os.O_RDWR, 0600) //nolint:gosec // root-owned directory and validated hex transfer identity
	if err != nil {
		return nil, err
	}
	defer func() { _ = lock.Close() }()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("standard import is still running")
	}
	interim := fmt.Sprintf("vm-%d-umiak-import-%s-%s", record.Args.TargetVmid, m[1], m[2])
	all, err := s.LVM.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, lv := range all {
		if lv.Name != a.Name && lv.Name != interim {
			continue
		}
		if lv.PoolLV != s.Cfg.ThinPool || len(lv.Attr) < 6 || lv.Attr[5] != '-' {
			return nil, forbidden("import volume is open or outside the Umiak pool")
		}
		if lv.Name == a.Name && (!ours(lv) || !slices.Contains(lv.Tags, "umiak-transfer-"+m[1]) || (record.Receipt.UUID != "" && record.Receipt.UUID != lv.UUID)) {
			return nil, forbidden("import volume ownership/generation changed")
		}
	}
	if a.Inspect {
		return map[string]any{"owned": true}, nil
	}

	for _, lv := range all {
		if lv.Name == a.Name || lv.Name == interim {
			if err = s.LVM.Remove(ctx, lv.Name); err != nil {
				return nil, err
			}
		}
	}
	if err = os.Remove(marker); err != nil {
		return nil, err
	}
	return map[string]any{"removed": true}, nil
}

var nodeNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$`)
var storageNameRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`)

func requireReadOnlyTemplate(lv lvm.LV) error {
	if !baseRe.MatchString(lv.Name) || len(lv.Attr) < 2 || lv.Attr[1] != 'r' {
		return forbidden("export requires a read-only template")
	}
	return nil
}
