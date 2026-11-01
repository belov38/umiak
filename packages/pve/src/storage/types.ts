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
	/** LV name in the VG, e.g. vm-500-disk-0 or umiak-snap-<id>-scsi0. */
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
	/** Set by Machines; absent in historical snapshot metadata. */
	consistency?: "crash" | "quiesced" | "powered_off";
	disks: DiskSet;
	/** Hardware config of the source without identity (smbios1, vmgenid, MAC, name) and disks. */
	hardware: Record<string, string>;
	createdAt: number;
	/** Time from the return of hook.freeze() to the call of hook.thaw(), for running machines. */
	freezeMs?: number;
	/**
	 * The guest released the freeze by itself before hook.thaw() (Windows VSS holds writes for
	 * about 10 s): the disks are crash-consistent only.
	 */
	autoThawed?: true;
}

export interface StorageUsage {
	dataPercent: number;
	metadataPercent: number;
	ourLvCount: number;
	ourLvUsedBytes: number;
}

export interface ThawResult {
	/** The guest had already thawed itself; the thaw call found nothing to release. */
	autoThawed?: boolean;
}

export interface QuiesceHook {
	freeze(): Promise<void>;
	// biome-ignore lint/suspicious/noConfusingVoidType: most hooks are `async () => {}`.
	thaw(): Promise<void | ThawResult>;
}

export interface StorageDriver {
	/** opts.skipSlots leaves slots out of the clone; the caller creates them (a fresh vTPM, S9 §9). */
	cloneFromTemplate(
		tpl: TemplateRef,
		target: VmTarget,
		opts?: { skipSlots?: DiskSlot[] },
	): Promise<DiskSet>;
	/** opts.id fixes the snapshot id; it must match ^[a-z0-9]{1,32}$ (used in LV names). */
	snapshot(
		m: MachineRef,
		hook: QuiesceHook,
		opts?: { id?: string },
	): Promise<SnapshotRef>;
	cloneFromSnapshot(s: SnapshotRef, target: VmTarget): Promise<DiskSet>;
	delete(ref: MachineDisksRef | SnapshotRef): Promise<void>;
	usage(node: NodeRef): Promise<StorageUsage>;
}
