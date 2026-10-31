// The Payload instance of this process: the same one the admin (RootLayout,
// RootPage) and the REST routes get, cached by Payload on globalThis, so it
// survives HMR re-evaluation in `next dev`.
import "server-only";
import config from "@payload-config";
import { getPayload, type Payload } from "payload";

export function getWebPayload(): Promise<Payload> {
	return getPayload({ config });
}
