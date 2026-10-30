// Schemas of the file routes (S7 §11.1): FileInfo, the query strings of
// content, archive and filesystem calls, and the JSON bodies of uploads,
// mkdir, move and chmod. Request objects are strict; query objects ignore
// unknown parameters, as elsewhere.
import { z } from "@hono/zod-openapi";
import { extensibleEnum } from "../openapi/registry.ts";
import { NullableTimestamp, PageQuery, SandboxParams } from "./common.ts";

export const FILE_TYPES = ["file", "dir", "symlink", "other"] as const;
export const ARCHIVE_FORMATS = ["tar", "tar.gz"] as const;

/** Default and maximum size of a chunk of a resumable upload (§11.1). */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** An upload without activity is dropped by the agent after this. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const PATH_MAX = 4096;

const FilePath = (description: string) =>
	z
		.string()
		.min(1)
		.max(PATH_MAX)
		.openapi({ description, example: "src/app.py" });

const PATH_DESCRIPTION =
	"Absolute, or relative to the home directory of `user` (`~` and `~/...` too)";

const BoolQuery = (description: string) =>
	z.enum(["true", "false"]).optional().openapi({ description });

/** A JSON file mode: permission bits with setuid, setgid and sticky. */
const Mode = z.int().min(0).max(0o7777);

const UserQuery = z.string().min(1).max(64).optional().openapi({
	description:
		"Guest user whose home relative paths start from and who owns new files (default `user`)",
});

export const FileInfoSchema = z
	.object({
		path: z.string().openapi({ description: "Absolute path in the sandbox" }),
		name: z.string().openapi({ description: "Last path component" }),
		type: extensibleEnum(FILE_TYPES),
		sizeBytes: z.int().min(0),
		mode: z.int().openapi({
			description: "Permission bits (0o7777 mask) as a number: 420 = 0644",
		}),
		owner: z.string(),
		group: z.string(),
		uid: z.int(),
		gid: z.int(),
		modifiedAt: NullableTimestamp,
		symlinkTarget: z
			.string()
			.nullable()
			.openapi({ description: "Target of a symlink; null for other types" }),
	})
	.openapi("FileInfo", { description: "A file, directory or symlink" });

export const FileListSchema = z
	.object({
		data: z.array(FileInfoSchema),
		nextCursor: z.string().nullable(),
	})
	.openapi("FileList");

export const ExistedSchema = z
	.object({
		existed: z.boolean().openapi({
			description: "false: there was nothing at the path (still a success)",
		}),
	})
	.openapi("FileRemoveResult");

export const UploadSchema = z
	.object({
		uploadId: z.string().openapi({ example: "upl_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		chunkSizeBytes: z.int().openapi({
			description: "Recommended chunk size (4 MiB)",
			example: UPLOAD_CHUNK_BYTES,
		}),
		maxChunkSizeBytes: z.int().openapi({
			description: "Largest accepted chunk (8 MiB); larger is 413",
			example: UPLOAD_MAX_CHUNK_BYTES,
		}),
		expiresAt: z.iso.datetime().openapi({
			description: "The partial upload is dropped after 24 h without activity",
		}),
	})
	.openapi("Upload");

export const UploadOffsetSchema = z
	.object({
		offset: z.int().min(0).openapi({
			description: "Bytes received so far: the offset of the next chunk",
		}),
	})
	.openapi("UploadOffset");

export const ArchiveResultSchema = z
	.object({
		path: z.string().openapi({ description: "The directory unpacked into" }),
		entries: z.int().min(0),
		sizeBytes: z.int().min(0).openapi({
			description: "Bytes of regular file data written",
		}),
	})
	.openapi("ArchiveResult");

// --- params and queries ---

export const UploadParams = SandboxParams.extend({
	upload: z.string().openapi({
		param: { name: "upload", in: "path" },
		description: "Upload id (`upl_...`) from POST .../files/uploads",
		example: "upl_01jbx2v7d3m6c8q9w0e4r5t6y7",
	}),
});

export const UserOnlyQuery = z.object({ user: UserQuery });

export const ContentQuery = z.object({
	path: FilePath(PATH_DESCRIPTION),
	user: UserQuery,
});

export const PutContentQuery = z.object({
	path: FilePath(PATH_DESCRIPTION),
	user: UserQuery,
	mode: z
		.string()
		.regex(/^0?[0-7]{3,4}$/)
		.optional()
		.openapi({
			description: "Octal mode of the file (default 644)",
			example: "0755",
		}),
	makeParents: BoolQuery("Create missing parent directories (default true)"),
	overwrite: BoolQuery(
		"Replace an existing file (default true); false: 409 already_exists",
	),
});

export const ChunkQuery = z.object({
	offset: z.coerce.number().int().min(0).openapi({
		description: "Must equal the bytes received so far (HEAD gives it)",
	}),
	path: FilePath(
		"The destination from POST (a hint where the agent keeps the partial file)",
	).optional(),
	user: UserQuery,
});

export const StatQuery = z.object({
	path: FilePath(PATH_DESCRIPTION),
	user: UserQuery,
	noFollow: BoolQuery("true: describe a symlink itself (default false)"),
});

export const ListQuery = z.object({
	path: FilePath(PATH_DESCRIPTION),
	user: UserQuery,
	depth: z.coerce
		.number()
		.int()
		.min(1)
		.max(8)
		.optional()
		.openapi({ description: "Levels below path, 1-8 (default 1)" }),
	includeHidden: BoolQuery("Include dot files (default true)"),
	...PageQuery,
});

export const RemoveQuery = z.object({
	path: FilePath(PATH_DESCRIPTION),
	user: UserQuery,
	recursive: BoolQuery(
		"Remove a directory with its contents (default false); symlinks are not followed",
	),
});

export const ArchiveGetQuery = z.object({
	path: FilePath(`The directory. ${PATH_DESCRIPTION}`),
	user: UserQuery,
	format: z
		.enum(ARCHIVE_FORMATS)
		.optional()
		.openapi({ description: "tar (POSIX pax, default) or tar.gz" }),
});

export const ArchivePutQuery = ArchiveGetQuery.extend({
	overwrite: BoolQuery(
		"Replace existing files (default true); false: 409 already_exists",
	),
	makeParents: BoolQuery("Create the directory and its parents (default true)"),
});

// --- request bodies ---

export const CreateUploadRequest = z
	.strictObject({
		path: FilePath(`Destination of the file. ${PATH_DESCRIPTION}`),
	})
	.openapi("CreateUploadRequest");

export const CommitUploadRequest = z
	.strictObject({
		path: FilePath(`Destination of the file. ${PATH_DESCRIPTION}`),
		sha256: z
			.string()
			.regex(/^[0-9a-fA-F]{64}$/)
			.optional()
			.openapi({
				description:
					"Hex SHA-256 of the whole file; a mismatch is 422 checksum_mismatch and drops the upload",
			}),
		mode: Mode.optional().openapi({
			description: "File mode (default 420 = 0644)",
		}),
		owner: z.string().min(1).max(64).optional().openapi({
			description: "Owner of the file (default `user`)",
		}),
		overwrite: z.boolean().optional().openapi({
			description: "Replace an existing file (default true)",
		}),
		makeParents: z.boolean().optional().openapi({
			description: "Create missing parent directories (default true)",
		}),
	})
	.openapi("CommitUploadRequest");

export const MakeDirRequest = z
	.strictObject({
		path: FilePath(PATH_DESCRIPTION),
		parents: z.boolean().optional().openapi({
			description: "Create missing parents too (default false)",
		}),
		mode: Mode.optional().openapi({
			description: "Directory mode (default 493 = 0755)",
		}),
	})
	.openapi("MakeDirRequest");

export const MoveRequest = z
	.strictObject({
		from: FilePath(PATH_DESCRIPTION),
		to: FilePath(PATH_DESCRIPTION),
		overwrite: z.boolean().optional().openapi({
			description: "Replace an existing destination (default false)",
		}),
	})
	.openapi("MoveRequest");

export const ChmodRequest = z
	.strictObject({
		path: FilePath(PATH_DESCRIPTION),
		mode: Mode.optional(),
		owner: z.string().min(1).max(64).optional(),
		group: z.string().min(1).max(64).optional(),
		recursive: z.boolean().optional().openapi({
			description: "Apply to the directory's contents too (default false)",
		}),
	})
	.openapi("ChmodRequest");
