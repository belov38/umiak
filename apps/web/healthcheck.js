// Exec probe of the web container (S8 §5.1): `node healthcheck.js`, exit 0
// when http://127.0.0.1:$PORT/healthz answers 200 within 3 s. Probes run
// inside the container, so the port stays closed to everything but
// oauth2-proxy.
const port = process.env.PORT || "3000";
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 3000);
fetch(`http://127.0.0.1:${port}/healthz`, { signal: ac.signal })
	.then((res) => {
		clearTimeout(timer);
		process.exit(res.status === 200 ? 0 : 1);
	})
	.catch(() => process.exit(1));
