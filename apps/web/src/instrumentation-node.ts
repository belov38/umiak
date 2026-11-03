// A bad environment stops the process with every problem listed, instead of
// failing each request (S8 §14.1).
import { isNextBuild, parseWebEnv } from "./lib/env";

if (!isNextBuild()) {
	try {
		const env = parseWebEnv(process.env);
		if (env.authMode === "owner")
			console.error(
				"WARNING: UMIAK_AUTH_MODE=owner trusts the ingress completely. Keep the web listener private behind the owner ingress.",
			);
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	}
}
