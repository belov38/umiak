import type { GlobalAfterChangeHook } from "payload";
import { notify } from "../notify.ts";

export const routesAfterChange: GlobalAfterChangeHook = async ({
	doc,
	previousDoc,
	req,
}) => {
	if (
		previousDoc?.publicPortsEnabled !== doc.publicPortsEnabled ||
		previousDoc?.publicDesktopEnabled !== doc.publicDesktopEnabled
	) {
		await notify(req, "umiak_routes", "*");
	}
	return doc;
};
