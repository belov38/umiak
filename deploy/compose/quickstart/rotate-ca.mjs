import { quickstartTls } from "./tls.mjs";

// Trusted Docker console only. Restart ingress afterwards to load these credentials.
const dir = process.env.UMIAK_QUICKSTART_TLS_DIR ?? "/var/lib/umiak/owner/tls";
const names = [
	...(process.env.UMIAK_QUICKSTART_TLS_NAMES ?? "").split(","),
	...process.argv.slice(2),
]
	.map((name) => name.trim())
	.filter(Boolean);
const tls = await quickstartTls(dir, names);
const next = await tls.updateNames(names, { rotateCA: true });
console.log(`New owner CA SHA256: ${next.caFingerprint}`);
console.log(
	"Restart quickstart to load the new CA. Replace old browser/CLI trust with ca.pem obtained through Docker. Owner sessions and guest gateway CA are unchanged.",
);
