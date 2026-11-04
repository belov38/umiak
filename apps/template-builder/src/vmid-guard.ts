// Inventory and ownership checks protect existing guests; ranges use PVE's minimum ID.
export const MIN_VMID = 100;
export function isProtectedVmid(vmid: number): boolean {
	return !Number.isInteger(vmid) || vmid < MIN_VMID || vmid > 999999999;
}
