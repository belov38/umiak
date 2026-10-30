// Access rules of the collections and the global (S8 §7): reads and writes
// through Payload access (REST /cms-api, /admin) are for operators only.
// api, worker and the server actions of web use the Local API with
// overrideAccess: true and check permissions themselves (S8 §9.11).
import type { Access } from "payload";

/** True when the request user is an operator (S8 §5.5). */
export function isOperatorReq(req: { user?: unknown }): boolean {
	const user = req.user as { isOperator?: unknown } | null | undefined;
	return user?.isOperator === true;
}

export const operatorOnly: Access = ({ req }) => isOperatorReq(req);

export const nobody: Access = () => false;

/** Collection access with every operation for operators only. */
export const operatorAccess = {
	read: operatorOnly,
	create: operatorOnly,
	update: operatorOnly,
	delete: operatorOnly,
} as const;
