// Public port settings of platform-defaults (S8 §8, S7 C7): the gateway
// refetches every route on NOTIFY sbx_routes '*'. A change of ssoPortPolicy
// from any to team bumps ssoPolicyEpoch, which ends sso cookies issued
// under the old policy (authEpoch = hosted_ports.auth_epoch + ssoPolicyEpoch).
import type { GlobalAfterChangeHook, GlobalBeforeChangeHook } from "payload";
import { notify } from "../notify.ts";

/** The hook owns ssoPolicyEpoch: written values are ignored, it only grows. */
export const ssoPolicyEpochBeforeChange: GlobalBeforeChangeHook = ({
	data,
	originalDoc,
}) => {
	const prevEpoch = Number(originalDoc?.ssoPolicyEpoch ?? 0);
	const prevPolicy = originalDoc?.ssoPortPolicy ?? "any";
	const nextPolicy = data.ssoPortPolicy ?? prevPolicy;
	data.ssoPolicyEpoch =
		prevPolicy === "any" && nextPolicy === "team" ? prevEpoch + 1 : prevEpoch;
	return data;
};

export const routesAfterChange: GlobalAfterChangeHook = async ({
	doc,
	previousDoc,
	req,
}) => {
	if (
		previousDoc?.publicPortsEnabled !== doc.publicPortsEnabled ||
		previousDoc?.publicDesktopEnabled !== doc.publicDesktopEnabled ||
		previousDoc?.ssoPortPolicy !== doc.ssoPortPolicy
	) {
		await notify(req, "sbx_routes", "*");
	}
	return doc;
};
