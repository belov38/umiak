// PTY requests (S7 §10): create, resize, and the query of the WebSocket
// connect. Request objects are strict (unknown fields are 400 validation).
import { z } from "@hono/zod-openapi";
import { PTY_MAX_SIZE, ptySize } from "../commands/pty-socket.ts";
import { COMMAND_MAX_BYTES } from "./command.ts";
import { EnvVars } from "./common.ts";

export const PTY_DEFAULT_COLS = 80;
export const PTY_DEFAULT_ROWS = 24;
export const PTY_DEFAULT_TERM = "xterm-256color";

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

export const CreatePtyRequest = z
	.strictObject({
		cols: ptySize.cols.optional().openapi({
			description: `Columns, 1 to ${PTY_MAX_SIZE} (default ${PTY_DEFAULT_COLS})`,
			example: 120,
		}),
		rows: ptySize.rows.optional().openapi({
			description: `Rows, 1 to ${PTY_MAX_SIZE} (default ${PTY_DEFAULT_ROWS})`,
			example: 32,
		}),
		command: z
			.string()
			.min(1)
			.refine((s) => byteLength(s) <= COMMAND_MAX_BYTES, {
				message: `must be at most ${COMMAND_MAX_BYTES} bytes`,
			})
			.refine((s) => !s.includes("\0"), { message: "must not contain NUL" })
			.nullable()
			.optional()
			.openapi({
				description:
					"Shell command line run by `bash -lc` in the terminal; null or absent: the user's login shell",
				example: null,
			}),
		cwd: z.string().max(4096).nullable().optional().openapi({
			description: "Working directory; relative to the user's home (default)",
		}),
		env: EnvVars.optional().openapi({
			description: "Variables of this terminal only; values are never stored",
		}),
		user: z.string().min(1).max(64).optional().openapi({
			description: "Guest user (default `user`; `root` is allowed)",
		}),
		term: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/)
			.optional()
			.openapi({
				description: `TERM of the terminal (default ${PTY_DEFAULT_TERM})`,
				example: PTY_DEFAULT_TERM,
			}),
	})
	.openapi("CreatePtyRequest");

export type CreatePtyBody = z.infer<typeof CreatePtyRequest>;

export const ResizePtyRequest = z
	.strictObject({
		cols: ptySize.cols.openapi({ example: 120 }),
		rows: ptySize.rows.openapi({ example: 32 }),
	})
	.openapi("ResizePtyRequest");

export const PtyConnectQuery = z.object({
	offset: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.openapi({
			description:
				"Output from this byte offset (default 0): the offset counted by the client, " +
				"`attached.offset` (or `truncated.availableFrom`) plus the bytes received",
		}),
	tailBytes: z.coerce.number().int().min(0).optional().openapi({
		description:
			"Start this many bytes before the end of the output (scrollback; ignores offset)",
	}),
});
