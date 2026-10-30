// VMIDs sbx-tpl never creates, stops or deletes, whatever the config or the allocator says:
// everything below 500 (other guests on the node), the PoC template 599, the base templates
// 9000 and 9001.

export const MIN_VMID = 500;
export const PROTECTED_VMIDS: ReadonlySet<number> = new Set([599, 9000, 9001]);

export function isProtectedVmid(vmid: number): boolean {
	return (
		!Number.isInteger(vmid) || vmid < MIN_VMID || PROTECTED_VMIDS.has(vmid)
	);
}
