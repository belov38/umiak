import { redirect } from "next/navigation";

/**
 * / → /app (temporary redirect). owner ingress returns a login started at the
 * app root to /, and web has no page of its own there. proxy.ts runs first,
 * so an anonymous request still gets 401.
 */
export default function RootIndex(): never {
	redirect("/app");
}
