// A bad environment stops the process with every problem listed, instead of
// failing each request (S8 §14.1).
import { isNextBuild, parseWebEnv } from "./lib/env";

if (!isNextBuild()) {
	try {
		const env = parseWebEnv(process.env);
		if (env.authMode === "none")
			console.error(
				"WARNING: UMIAK_AUTH_MODE=none grants full VM control to every allowed network client. Keep the web listener private behind the local ingress.",
			);
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	}
}
