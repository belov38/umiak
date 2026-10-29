/** Disk slots a machine may have. efidisk0 and tpmstate0 are for Windows (S9). */
export type DiskSlot = "efidisk0" | "scsi0" | "tpmstate0";

/** Canonical slot order; LV index k in vm-<vmid>-disk-<k> follows it. */
export const SLOT_ORDER: readonly DiskSlot[] = [
	"efidisk0",
	"scsi0",
	"tpmstate0",
];

export interface Disk {
	slot: DiskSlot;
	/** Proxmox volume id, e.g. local-lvm:vm-500-disk-0. */
	volid: string;
	/** LV name in the VG, e.g. vm-500-disk-0 or sbx-snap-<id>-scsi0. */
	lv: string;
	/** Disk options other than the volume and size: discard, iothread, ssd, efitype, version... */
	options: Record<string, string>;
}

export type DiskSet = Disk[];

export interface NodeRef {
	node: string;
}

export interface TemplateRef extends NodeRef {
	vmid: number;
	disks: DiskSet;
}

export interface VmTarget extends NodeRef {
	vmid: number;
}

export interface MachineRef extends NodeRef {
	vmid: number;
	disks: DiskSet;
	running: boolean;
}

export interface MachineDisksRef extends NodeRef {
	kind: "machine";
	vmid: number;
}

export interface SnapshotRef extends NodeRef {
	kind: "snapshot";
	id: string;
	sourceVmid: number;
	disks: DiskSet;
	/** Hardware config of the source without identity (smbios1, vmgenid, MAC, name) and disks. */
	hardware: Record<string, string>;
	createdAt: number;
	/** Time from the start of freeze to the end of thaw, for running machines. */
	freezeMs?: number;
}

export interface StorageUsage {
	dataPercent: number;
	metadataPercent: number;
	ourLvCount: number;
	ourLvUsedBytes: number;
}

export interface QuiesceHook {
	freeze(): Promise<void>;
	thaw(): Promise<void>;
}

export interface StorageDriver {
	cloneFromTemplate(tpl: TemplateRef, target: VmTarget): Promise<DiskSet>;
	snapshot(m: MachineRef, hook: QuiesceHook): Promise<SnapshotRef>;
	cloneFromSnapshot(s: SnapshotRef, target: VmTarget): Promise<DiskSet>;
	delete(ref: MachineDisksRef | SnapshotRef): Promise<void>;
	usage(node: NodeRef): Promise<StorageUsage>;
}
