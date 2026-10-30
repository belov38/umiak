// api process entry point: `node src/main.ts` (type stripping, no build of
// the api itself). Reads the environment (src/settings.ts), starts the four
// listeners (src/server.ts) and stops gracefully on SIGTERM/SIGINT
// (src/shutdown.ts): at most 10 s, then exit 0.
// `@sbx/agent-client` and `@sbx/proto` are loaded from their `dist`: run
// `pnpm build` once before `node src/main.ts` (the image does it).
import { createApiLogger } from "./http/logger.ts";
import { startApi } from "./server.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { onShutdownSignals } from "./shutdown.ts";

async function main(): Promise<void> {
	let settings: Settings;
	try {
		settings = loadSettings(process.env);
	} catch (err) {
		process.stderr.write(
			`sbx-api: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	}
	const log = createApiLogger({ level: settings.logLevel });
	process.on("unhandledRejection", (reason) => {
		log.error(
			{ err: reason instanceof Error ? reason.message : String(reason) },
			"unhandled rejection",
		);
	});
	try {
		const api = await startApi(settings, undefined, { log });
		onShutdownSignals(process, {
			close: () => api.close(),
			exit: (code) => process.exit(code),
			log,
		});
	} catch (err) {
		log.fatal(
			{ err: err instanceof Error ? err.message : String(err) },
			"api failed to start",
		);
		process.exit(1);
	}
}

await main();
