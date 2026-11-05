package ops

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
)

var nodeNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$`)
var storageNameRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`)
var machineUUIDRe = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type vmTransferArgs struct {
	VMID      int    `json:"vmid"`
	Target    string `json:"target"`
	Storage   string `json:"storage"`
	ID        string `json:"id"`
	MachineID string `json:"machineId"`
}

// Fixed code uses the same PVE::QemuConfig lock and atomic config relocation as
// PVE migration. A migrate lock fences target starts until the DB commit.
const switchVMConfig = `use strict; use warnings; use PVE::QemuConfig;
my ($vmid,$target,$source_storage,$target_storage,$id,$uuid)=@ARGV;
PVE::QemuConfig->lock_config($vmid,sub {
 my $c=PVE::QemuConfig->load_config($vmid);
 die "not Umiak" unless grep {$_ eq 'umiak'} split(/[;, ]/,$c->{tags}//'');
 die "wrong machine" unless ($c->{smbios1}//'') =~ /(?:^|,)uuid=\Q$uuid\E(?:,|$)/;
 die "VM is locked" if $c->{lock} && !($c->{lock} eq 'migrate' && grep {$_ eq 'umiak-move-'.$id} split(/[;, ]/,$c->{tags}//''));
 die "target config exists" if -e PVE::QemuConfig->config_file($vmid,$target);
 open(my $st,'-|','/usr/sbin/qm','status',$vmid) or die "cannot check power";
 my $status=do{local $/;<$st>};close($st) or die "power status failed";
 die "VM is not stopped" unless $status =~ /^status: stopped\s*$/;
 for my $key(keys %$c){next unless $key =~ /^(?:scsi|sata|virtio|ide|efidisk|tpmstate)\d+$/;
  die "cloudinit disk must be regenerated before relocation" if $c->{$key} =~ /^\Q$source_storage\E:.*cloudinit/;
  next if $c->{$key} =~ /media=cdrom/;
  die "unsupported disk slot" unless $key =~ /^(?:scsi0|efidisk0|tpmstate0)$/;
  die "unsupported local disk" if $c->{$key} =~ /^\Q$source_storage\E:/ && $c->{$key} !~ /^\Q$source_storage\E:vm-\Q$vmid\E-disk-\d+(?:,|$)/;
  $c->{$key} =~ s/^\Q$source_storage\E:/$target_storage:/;
 }
 $c->{lock}='migrate';$c->{tags}=($c->{tags}//'').';umiak-move-'.$id;
 PVE::QemuConfig->write_config($vmid,$c);
 PVE::QemuConfig->move_config_to_node($vmid,$target);
});`
const unlockVMConfig = `use strict; use warnings; use PVE::QemuConfig;
my($vmid,$id,$uuid)=@ARGV;
PVE::QemuConfig->lock_config($vmid,sub{
 my $c=PVE::QemuConfig->load_config($vmid);
 die "wrong transfer" unless grep {$_ eq 'umiak-move-'.$id} split(/[;, ]/,$c->{tags}//'');
 die "wrong machine" unless ($c->{smbios1}//'') =~ /(?:^|,)uuid=\Q$uuid\E(?:,|$)/;
 die "unexpected lock" if $c->{lock} && $c->{lock} ne 'migrate';
 delete $c->{lock};PVE::QemuConfig->write_config($vmid,$c);
});`

func (s *Server) vmTransferSwitch(ctx context.Context, raw json.RawMessage) (any, error) {
	var a vmTransferArgs
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	if !s.Cfg.InRange(a.VMID) || !transferIDRe.MatchString(a.ID) || !machineUUIDRe.MatchString(a.MachineID) || !nodeNameRe.MatchString(a.Target) || a.Target == s.Cfg.Node || !storageNameRe.MatchString(a.Storage) {
		return nil, forbidden("invalid relocation identity")
	}
	targetPath := fmt.Sprintf("etc/pve/nodes/%s/qemu-server", a.Target)
	if info, err := fs.Stat(s.Host.FS, targetPath); err != nil || !info.IsDir() {
		return nil, forbidden("unknown target node")
	}
	conf, err := fs.ReadFile(s.Host.FS, fmt.Sprintf("etc/pve/qemu-server/%d.conf", a.VMID))
	if err != nil {
		moved, readErr := fs.ReadFile(s.Host.FS, fmt.Sprintf("%s/%d.conf", targetPath, a.VMID))
		if readErr != nil || !ownedMovedConfig(string(moved), a.Storage, a.VMID, a.ID, a.MachineID) {
			return nil, forbidden("source config missing or relocation ambiguous")
		}
		return map[string]any{"moved": true}, nil
	}
	if _, ok := sandboxDisks(string(conf), s.Cfg.Storage, a.VMID); !ok || !strings.Contains(string(conf), "uuid="+a.MachineID) {
		return nil, forbidden("config is not the owned sandbox")
	}
	status, err := s.Host.Run(ctx, "qm", "status", fmt.Sprint(a.VMID))
	if err != nil || strings.TrimSpace(string(status)) != "status: stopped" {
		return nil, forbidden("source VM is not stopped")
	}
	if _, err := s.Host.Run(ctx, "perl", "-e", switchVMConfig, "--", fmt.Sprint(a.VMID), a.Target, s.Cfg.Storage, a.Storage, a.ID, a.MachineID); err != nil {
		return nil, err
	}
	return map[string]any{"moved": true}, nil
}
func (s *Server) vmTransferUnlock(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		VMID      int    `json:"vmid"`
		ID        string `json:"id"`
		MachineID string `json:"machineId"`
	}
	if err := decodeArgs(raw, &a); err != nil {
		return nil, err
	}
	if !s.Cfg.InRange(a.VMID) || !transferIDRe.MatchString(a.ID) || !machineUUIDRe.MatchString(a.MachineID) {
		return nil, forbidden("invalid relocation identity")
	}
	if _, err := s.Host.Run(ctx, "perl", "-e", unlockVMConfig, "--", fmt.Sprint(a.VMID), a.ID, a.MachineID); err != nil {
		return nil, err
	}
	return map[string]any{"unlocked": true}, nil
}

// An already-moved config is proof only when all identity fields match in
// the current section; a comment or snapshot section cannot authorize it.
func ownedMovedConfig(conf, storage string, vmid int, id, uuid string) bool {
	if _, ok := sandboxDisks(conf, storage, vmid); !ok {
		return false
	}
	marker, identity := false, false
	for line := range strings.Lines(conf) {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if k == "tags" {
			for _, t := range strings.FieldsFunc(v, func(r rune) bool { return r == ';' || r == ',' || r == ' ' }) {
				if t == "umiak-move-"+id {
					marker = true
				}
			}
		}
		if k == "smbios1" {
			for _, part := range strings.Split(v, ",") {
				if strings.TrimSpace(part) == "uuid="+uuid {
					identity = true
				}
			}
		}
	}
	return marker && identity
}
