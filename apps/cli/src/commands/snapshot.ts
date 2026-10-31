// `sbx snapshot save [<sb>] <name> [--wait]`, `snapshot list`,
// `snapshot rm <name>... [--yes]` (S7 §13, §5.12). save prints
// `{snapshot, operation}`; with --wait, like the other waiting commands
// (§14.3), the JSON Lines `accepted` ({snapshot, operation}) and last `ready`
// ({snapshot}), or the error line if the save fails. A snapshot with the same
// name is replaced once the new one is ready. rm asks like `sbx rm` and sends
// `Sbx-Confirm-Delete`. save --force-stop: a running Windows sandbox is
// stopped for the snapshot and started again (S9 §24.8).

import type { SnapshotData } from "@sbx/sdk";
import { newIdempotencyKey, SbxError } from "@sbx/sdk";
import type { Command } from "commander";
import { parseDuration } from "../args.ts";
import { confirm } from "../confirm.ts";
import { sandboxRef, writeCurrent } from "../current.ts";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";
import { WAIT_TIMEOUT_MS, warnForceStop } from "../wait.ts";
import { FORCE_STOP_HELP } from "./lifecycle.ts";

function snapshotLine(s: SnapshotData): string {
	return `${s.name} (${s.id}): ${s.state}`;
}

export function register(program: Command, run: Runner): void {
	const snap = program
		.command("snapshot")
		.description("saved snapshots of the team");

	snap
		.command("save")
		.description("save a snapshot of a sandbox under a name")
		.argument(
			"<sb-or-name>",
			"sandbox ID or slug, or the name (current sandbox)",
		)
		.argument("[name]", "snapshot name: ^[a-z0-9][a-z0-9-]{0,62}$")
		.option("--wait", "wait until the snapshot is ready and print it")
		.option("--wait-timeout <duration>", "limit of --wait")
		.option("--force-stop", FORCE_STOP_HELP)
		.action(
			run(async (ctx, args, opts) => {
				const [a, b] = args as [string, string | undefined];
				const ref = sandboxRef(ctx, b === undefined ? undefined : a);
				const name = b ?? a;
				const timeoutMs =
					opts.waitTimeout === undefined
						? WAIT_TIMEOUT_MS
						: parseDuration(opts.waitTimeout as string, "--wait-timeout") *
							1000;
				const sbx = ctx.sbx();
				const { data } = await sbx.raw.POST("/v1/snapshots", {
					body: {
						sandbox: ref.ref,
						name,
						...(opts.forceStop === true ? { forceStop: true } : {}),
					},
					idempotencyKey: newIdempotencyKey(),
				});
				const source = data.snapshot.sourceSandboxId;
				if (ref.explicit && source) writeCurrent(ctx, source);
				if (opts.wait !== true) {
					ctx.out.result(data, (v) => `Saving ${snapshotLine(v.snapshot)}`);
					return;
				}
				ctx.out.event(
					"accepted",
					data,
					(v) => `Saving ${snapshotLine(v.snapshot)}`,
				);
				const op = await sbx.waitForOperation(data.operation, { timeoutMs });
				if (op.state !== "succeeded") {
					throw new SbxError({
						status: 0,
						code: op.error?.code ?? `operation_${op.state}`,
						message:
							op.error?.message ?? `saving snapshot ${name} is ${op.state}`,
						retryable: op.error?.retryable ?? false,
						details: { operationId: op.id, kind: op.kind, state: op.state },
					});
				}
				warnForceStop(ctx, op);
				const s = await sbx.snapshots.get(name);
				ctx.out.event("ready", { snapshot: s }, (v) =>
					snapshotLine(v.snapshot),
				);
			}),
		);

	snap
		.command("list")
		.alias("ls")
		.description(
			"list the saved snapshots (with creating and recently failed ones)",
		)
		.action(
			run(async (ctx) => {
				const { data } = await ctx.sbx().raw.GET("/v1/snapshots");
				ctx.out.result(data, (v) =>
					v.data.length === 0
						? "No snapshots."
						: table(
								["NAME", "ID", "STATE", "SOURCE", "SIZE", "CREATED"],
								v.data.map((s) => [
									s.name,
									s.id,
									s.state,
									s.sourceSandboxId,
									s.size,
									s.createdAt,
								]),
							),
				);
			}),
		);

	snap
		.command("rm")
		.description("delete saved snapshots")
		.argument("<name...>", "snapshot names")
		.option("-y, --yes", "do not ask (required without a terminal)")
		.action(
			run(async (ctx, args, opts) => {
				const names = args[0] as string[];
				const yes = opts.yes === true;
				if (!yes && !ctx.interactive) await confirm(ctx, false, "");
				const sbx = ctx.sbx();
				const snaps: SnapshotData[] = [];
				for (const n of names) snaps.push(await sbx.snapshots.get(n));
				await confirm(
					ctx,
					yes,
					`Delete snapshot${snaps.length === 1 ? "" : "s"} ${snaps.map(snapshotLine).join(", ")}?`,
				);
				let first: unknown;
				for (const s of snaps) {
					try {
						await sbx.raw.DELETE("/v1/snapshots/{name}", {
							params: { path: { name: s.name } },
							headers: { "Sbx-Confirm-Delete": s.id },
						});
						ctx.out.result(
							{ id: s.id, name: s.name, deleted: true },
							(v) => `Deleted snapshot ${v.name} (${v.id})`,
						);
					} catch (err) {
						first ??= err;
						if (snaps.length > 1) {
							ctx.out.warn(`${s.name}: ${(err as Error).message}`);
						}
					}
				}
				if (first !== undefined) throw first;
			}),
		);
}
