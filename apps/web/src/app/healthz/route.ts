// Exec probe target (S8 §5.1, §12): no identity headers needed; 200 "ok"
// once Postgres answers, Payload is initialized and every migration known
// to this code is applied. Nothing else is said.
import { assertPayloadMigrated } from "@umiak/payload";
import { getWebPayload } from "@/lib/payload";

export const dynamic = "force-dynamic";

const TEXT = { "Content-Type": "text/plain; charset=utf-8" };

export async function GET(): Promise<Response> {
	try {
		const payload = await getWebPayload();
		await assertPayloadMigrated(payload);
		return new Response("ok", { status: 200, headers: TEXT });
	} catch (e) {
		console.error("healthz:", e instanceof Error ? e.message : e);
		return new Response("unavailable", { status: 503, headers: TEXT });
	}
}
