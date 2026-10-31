// Runs once when the server starts (Node.js runtime only).
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		await import("./instrumentation-node");
	}
}
