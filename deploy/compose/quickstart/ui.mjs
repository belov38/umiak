import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The standalone owner gate must render before Next or an owner session exists.
// Consume the dashboard's tokens directly: there is no second colour palette.
const dashboard = readFileSync(
	new URL("../../../apps/web/src/app/globals.css", import.meta.url),
	"utf8",
);
const tokens = [":root", ".dark"]
	.map((selector) => {
		const start = dashboard.indexOf(`\n${selector} {`);
		if (start < 0) throw new Error(`Missing dashboard tokens: ${selector}`);
		return dashboard.slice(start, dashboard.indexOf("}", start) + 1);
	})
	.join("\n");
const brand = readFileSync(
	new URL(
		"../../../apps/web/public/brand/lockup-inter-light.svg",
		import.meta.url,
	),
	"utf8",
).replace(/fill="(?!none)[^"]+"/g, 'fill="currentColor"');
const escapeHtml = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			],
	);

const style = `
@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;font-display:swap;src:url(/quickstart/ui/inter.woff2) format("woff2")}
@font-face{font-family:"Funnel Display Variable";font-style:normal;font-weight:300 800;font-display:swap;src:url(/quickstart/ui/funnel.woff2) format("woff2")}
${tokens}
*{box-sizing:border-box}html{font-size:90%;color-scheme:light}html.dark{color-scheme:dark}body{margin:0;font:1rem/1.5 "Inter Variable",system-ui,sans-serif;background:var(--background);color:var(--foreground)}
a{color:var(--link);text-decoration:underline;text-underline-offset:3px}h1,h2,summary{font-family:"Funnel Display Variable",system-ui,sans-serif;letter-spacing:-.035em}h1{font-size:2.5rem;line-height:1.1;margin:0 0 24px}h2{font-size:1.5rem}
.sidebar{position:fixed;inset:0 auto 0 0;width:17.5rem;border-right:1px solid var(--border);padding:24px 16px;display:flex;flex-direction:column;gap:24px;background:var(--background)}.brand{font-size:1.75rem;color:var(--foreground);font-weight:600;text-decoration:none;padding:0 12px}.brand svg{height:32px;width:auto}.sidebar nav{display:grid;gap:4px}.sidebar nav a{display:flex;align-items:center;gap:12px;min-height:var(--control-height);padding:8px 12px;text-decoration:none;color:var(--muted-foreground)}.sidebar nav a:hover{background:var(--accent);color:var(--foreground)}.sidebar nav svg{width:18px;height:18px;flex-shrink:0}.appearance{margin-top:auto;display:flex;gap:8px}
main{margin-left:17.5rem;padding:32px;min-width:0}.work-area{max-width:72rem}footer{margin-top:32px;color:var(--muted-foreground)}section,details{border:1px solid var(--border);background:var(--card);padding:20px;margin:20px 0}summary{cursor:pointer;font-size:1.5rem;font-weight:600}label{display:block;margin:12px 0}input,textarea,select{display:block;width:100%;min-height:var(--control-height);padding:8px 12px;background:transparent;color:var(--foreground);border:1px solid var(--input);border-radius:0;font:inherit}input[type=hidden]{display:none}input[type=checkbox]{display:inline-block;width:18px;min-height:18px;height:18px;vertical-align:middle;margin:0 8px 0 0;accent-color:var(--primary)}textarea{min-height:100px}button{font:inherit;font-weight:500;min-height:var(--control-height);border:1px solid transparent;border-radius:0;padding:8px 16px;background:var(--primary);color:var(--primary-foreground);cursor:pointer;margin:4px 4px 4px 0}button:hover{background:var(--primary-hover)}button.outline{background:transparent;color:var(--foreground);border-color:var(--input)}button.outline:hover{background:var(--accent)}button.destructive{background:transparent;color:var(--destructive)}button.destructive:hover{background:var(--destructive-tint)}button[aria-pressed=true]{background:var(--secondary);color:var(--link);border-color:var(--ring)}button:disabled{opacity:.5;cursor:default}:is(a,button,input,textarea,select,summary):focus-visible{outline:2px solid var(--ring);outline-offset:2px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:0.875rem/1.5 ui-monospace,monospace}code{overflow-wrap:anywhere}.copy{background:var(--muted);padding:12px;margin:12px 0}.error{color:var(--destructive)}.ready{color:var(--success)}.pending,small{color:var(--muted-foreground)}#result{white-space:pre-wrap}progress{width:100%;accent-color:var(--primary)}.skip{position:absolute;left:16px;top:-100px}.skip:focus{top:8px;z-index:2;background:var(--background);padding:8px}
@media(min-width:768px){:root{--control-height:3rem}}@media(max-width:767px){.sidebar{position:static;width:auto;border-right:0;border-bottom:1px solid var(--border);gap:12px;padding:16px}.sidebar nav{display:flex;flex-wrap:wrap}.sidebar nav a{padding:8px}.appearance{margin-top:0}main{margin-left:0;padding:24px 16px}h1{font-size:2rem}section,details{padding:16px}}
`;
const icon = (path) =>
	`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
const nav = (href, label, path) =>
	`<a href="${href}">${icon(path)}${label}</a>`;
export function renderPage(title, content) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Umiak</title><script>try{const saved=localStorage.getItem('umiak-theme');document.documentElement.classList.toggle('dark',saved==='dark'||(saved!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))}catch{}</script><style>${style}</style></head><body><a class="skip" href="#main">Skip to content</a><aside class="sidebar"><a class="brand" href="/app" aria-label="Umiak home">${brand}</a><nav aria-label="Main navigation">${nav("/app", "Sandboxes", "M3 6h18v14H3z M3 6l9-4 9 4 M12 10v10")}${nav("/setup", "Setup", "m5 12 4 4L19 6 M3 3h18v18H3z")}${nav("/app/getting-started", "Getting started", "M4 3h16v18H4z M8 7h8 M8 11h8 M8 15h5")}${nav("/owner/sessions", "Owner sessions", "M3 4h18v12H3z M8 20h8 M12 16v4")}</nav><div class="appearance" role="group" aria-label="Appearance"><button class="outline" type="button" data-theme="light" aria-pressed="false">Light</button><button class="outline" type="button" data-theme="dark" aria-pressed="false">Dark</button></div></aside><main id="main" tabindex="-1"><div class="work-area">${content}<footer>Self-hosted. Your machines, your control plane.</footer></div></main><script>const themeButtons=document.querySelectorAll('[data-theme]');function syncTheme(){const dark=document.documentElement.classList.contains('dark');themeButtons.forEach(b=>b.setAttribute('aria-pressed',String((b.dataset.theme==='dark')===dark)))}themeButtons.forEach(b=>b.onclick=()=>{document.documentElement.classList.toggle('dark',b.dataset.theme==='dark');try{localStorage.setItem('umiak-theme',b.dataset.theme)}catch{}syncTheme()});syncTheme();</script></body></html>`;
}

// Only these fixed, public presentation assets bypass the owner gate.
export function uiAsset(path, res, assetsDir) {
	const fonts = {
		"/quickstart/ui/inter.woff2": [
			"inter.woff2",
			"@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
		],
		"/quickstart/ui/funnel.woff2": [
			"funnel.woff2",
			"@fontsource-variable/funnel-display/files/funnel-display-latin-wght-normal.woff2",
		],
	};
	const font = fonts[path];
	if (!font) return false;
	const local = new URL(
		`../../../apps/web/node_modules/${font[1]}`,
		import.meta.url,
	);
	const bundled = assetsDir && join(assetsDir, font[0]);
	const file = bundled && existsSync(bundled) ? bundled : local;
	if (!existsSync(file)) {
		res.writeHead(404);
		res.end();
		return true;
	}
	res.writeHead(200, {
		"content-type": "font/woff2",
		"cache-control": "public,max-age=86400",
	});
	res.end(readFileSync(file));
	return true;
}
