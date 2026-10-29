// FileInfo of the agent (S3 §11.4) → the public FileInfo (S7 §11.1).
import type { AgentFileInfo } from "../agent/types.ts";
import { isoOrNull } from "./operation.ts";

export interface FileInfoResource {
	path: string;
	name: string;
	type: AgentFileInfo["type"];
	sizeBytes: number;
	mode: number;
	owner: string;
	group: string;
	uid: number;
	gid: number;
	modifiedAt: string | null;
	symlinkTarget: string | null;
}

export function toFileInfo(i: AgentFileInfo): FileInfoResource {
	return {
		path: i.path,
		name: i.name,
		type: i.type,
		sizeBytes: i.size,
		mode: i.mode,
		owner: i.owner,
		group: i.group,
		uid: i.uid,
		gid: i.gid,
		modifiedAt: isoOrNull(i.mtime),
		symlinkTarget: i.type === "symlink" ? i.symlinkTarget : null,
	};
}
