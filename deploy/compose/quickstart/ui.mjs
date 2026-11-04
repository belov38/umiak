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
a{color:var(--link);text-decoration:underline;text-underline-offset:3px}h1,h2,summary{font-family:"Funnel Display Variable",system-ui,sans-serif;letter-spacing:-.035em}h1{font-size:2rem;font-weight:400;letter-spacing:-.02em;line-height:1.1;margin:0 0 24px}h2{font-size:1.5rem}
.sidebar{overflow-y:auto;position:fixed;inset:0 auto 0 0;width:17.5rem;border-right:1px solid var(--border);padding:1.5rem 1rem;display:flex;flex-direction:column;gap:1.5rem;background:var(--background)}.brand{display:flex;align-items:center;height:44px;color:var(--foreground);text-decoration:none;padding:0 .75rem}.brand-row{display:flex;align-items:center;justify-content:space-between}.brand-divider{padding-bottom:1rem;border-bottom:1px solid var(--border)}.navigation-frame{display:flex;flex:1;flex-direction:column;gap:1.5rem}.mobile-menu{display:none}.brand svg{height:32px;width:auto}.sidebar nav{display:grid;gap:4px}.sidebar nav a{display:flex;align-items:center;gap:8px;min-height:40px;padding:8px 12px;text-decoration:none;color:var(--muted-foreground)}.sidebar nav a:hover{background:var(--accent);color:var(--foreground)}.sidebar nav svg{width:18px;height:18px;flex-shrink:0}.sidebar-footer{margin-top:auto;display:grid;gap:8px}.appearance{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--border);margin-top:12px}.appearance button{display:flex;align-items:center;gap:8px;margin:0;padding:8px;min-width:0;height:48px;border:0;background:transparent;color:var(--muted-foreground)}.appearance button+button{border-left:1px solid var(--border)}.appearance svg{width:18px;height:18px}.appearance button[aria-pressed=true]{background:var(--secondary);color:var(--secondary-foreground)}.sidebar nav a[aria-current=page]{background:var(--secondary);color:var(--secondary-foreground)}
main{margin-left:17.5rem;padding:2rem;min-width:0}.work-area{max-width:72rem}footer{margin-top:32px;color:var(--muted-foreground)}section,details{border:1px solid var(--border);background:var(--card);padding:20px;margin:20px 0}summary{cursor:pointer;font-size:1.5rem;font-weight:600}label{display:block;margin:12px 0}input,textarea,select{display:block;width:100%;min-height:var(--control-height);padding:8px 12px;background:transparent;color:var(--foreground);border:1px solid var(--input);border-radius:0;font:inherit}input[type=hidden]{display:none}input[type=checkbox]{display:inline-block;width:18px;min-height:18px;height:18px;vertical-align:middle;margin:0 8px 0 0;accent-color:var(--primary)}textarea{min-height:100px}button{font:inherit;font-weight:500;min-height:var(--control-height);border:1px solid transparent;border-radius:0;padding:8px 16px;background:var(--primary);color:var(--primary-foreground);cursor:pointer;margin:4px 4px 4px 0}button:hover{background:var(--primary-hover)}button.outline{background:transparent;color:var(--foreground);border-color:var(--input)}button.outline:hover{background:var(--accent)}button.destructive{background:transparent;color:var(--destructive)}button.destructive:hover{background:var(--destructive-tint)}button[aria-pressed=true]{background:var(--secondary);color:var(--link);border-color:var(--ring)}button:disabled{opacity:.5;cursor:default}:is(a,button,input,textarea,select,summary):focus-visible{outline:2px solid var(--ring);outline-offset:2px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:0.875rem/1.5 ui-monospace,monospace}code{overflow-wrap:anywhere}.copy{background:var(--muted);padding:12px;margin:12px 0}.error{color:var(--destructive)}.ready{color:var(--success)}.pending,small{color:var(--muted-foreground)}#result{white-space:pre-wrap}.progress{display:flex;height:8px;background:var(--muted);width:100%}.progress span{background:var(--primary);flex:none}.skip{position:absolute;left:16px;top:-100px}.skip:focus{top:8px;z-index:2;background:var(--background);padding:8px}
.primary-action{display:inline-block;padding:8px 16px;background:var(--primary);color:var(--primary-foreground);text-decoration:none}details details summary{font-size:1.125rem}details[name=setup-step]:not([open]){padding:12px 16px;margin:12px 0}details[name=setup-step]:not([open]) summary{font-size:1.125rem}summary{overflow-wrap:anywhere}
.access-header{display:flex;justify-content:space-between;align-items:center;padding:16px;border-bottom:1px solid var(--border);gap:16px}.access-header .appearance{margin:0}.access main{margin:0 auto;max-width:52rem}.access-header .brand{padding:0}
@media(min-width:768px){:root{--control-height:3rem}}@media(max-width:1023px){.sidebar{position:static;width:auto;border-right:0;border-bottom:1px solid var(--border);gap:0;padding:8px 16px}.brand{padding:0;height:40px}.brand svg{height:24px}.brand-divider{display:none}.navigation-frame{display:none;padding:16px 0;gap:16px}.sidebar[data-open=true] .navigation-frame{display:flex}.mobile-menu{display:flex;align-items:center;justify-content:center;width:40px;min-height:40px;margin:0;padding:8px;background:transparent;color:var(--foreground)}.mobile-menu svg{height:18px;width:18px}.sidebar-footer{margin-top:0}.sidebar nav{display:grid}.appearance{margin-top:0}main{margin-left:0;padding:1.5rem}section,details{padding:16px}}

`;
const icon = (path) =>
	`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
const nav = (href, label, path, current) =>
	`<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${icon(path)}${label}</a>`;
export function renderPage(title, content, { authenticated = true } = {}) {
	const current =
		title === "Owner sessions"
			? "/owner/sessions"
			: title === "Setup"
				? "/setup"
				: "";
	const item = (href, label, path) => nav(href, label, path, current);
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Umiak</title><script>try{const saved=localStorage.getItem('umiak-theme');document.documentElement.classList.toggle('dark',saved==='dark'||(saved!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))}catch{}</script><style>${style}.signin-minted{display:block;font-size:clamp(1.25rem,4vw,2rem);font-family:monospace;overflow-wrap:anywhere;margin-block:16px}</style></head><body><a class="skip" href="#main">Skip to content</a><aside class="sidebar"><div class="brand-row"><a class="brand" href="/app" aria-label="Umiak home">${brand}</a><button class="mobile-menu" aria-label="Open navigation" aria-expanded="false" aria-controls="owner-navigation">${icon("M4 6h16 M4 12h16 M4 18h16")}</button></div><div class="brand-divider"></div><div class="navigation-frame" id="owner-navigation"><nav aria-label="Main navigation">${item("/app", "Sandboxes", "M3 6h18v14H3z M3 6l9-4 9 4 M12 10v10")}${item("/app/snapshots", "Snapshots", "M3 3h18v5H3z M5 8v13h14V8 M10 12h4")}${item("/app/environments", "Environment", "m12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5")}${item("/app/keys", "API keys", "M15 7a4 4 0 1 1-4 4L3 19v2h4v-3h3l3-3")}${item("/app/templates", "Templates", "M4 4h16v16H4z M4 10h16 M10 10v10")}${item("/app/getting-started", "Getting started", "M4 3h16v18H4z M8 7h8 M8 11h8 M8 15h5")}${item("/app/settings", "Settings", "M4 7h16 M4 17h16 M8 3v8 M16 13v8")}</nav><div class="sidebar-footer"><nav aria-label="Owner navigation">${item("/setup", "Setup", "m5 12 4 4L19 6 M3 3h18v18H3z")}${item("/owner/sessions", "Owner sessions", "M20 21v-2a7 7 0 0 0-14 0v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0")}</nav><div class="appearance" role="group" aria-label="Appearance"><button type="button" data-theme="light" aria-pressed="false">${icon("M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1")}Light</button><button type="button" data-theme="dark" aria-pressed="false">${icon("M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13")}Dark</button></div></div></div></aside><main id="main" tabindex="-1"><div class="work-area">${content}<footer>Self-hosted. Your machines, your control plane.</footer></div></main><script>const menu=document.querySelector('.mobile-menu');if(menu)menu.onclick=()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Close navigation':'Open navigation');document.querySelector('.sidebar').dataset.open=String(open)};const themeButtons=document.querySelectorAll('[data-theme]');function syncTheme(){const dark=document.documentElement.classList.contains('dark');themeButtons.forEach(b=>b.setAttribute('aria-pressed',String((b.dataset.theme==='dark')===dark)))}themeButtons.forEach(b=>b.onclick=()=>{document.documentElement.classList.toggle('dark',b.dataset.theme==='dark');try{localStorage.setItem('umiak-theme',b.dataset.theme)}catch{}syncTheme()});syncTheme();</script></body></html>`;
	if (authenticated) return html;
	const appearance = html
		.slice(html.indexOf('<div class="appearance"'), html.indexOf("</aside>"))
		.replace(/<\/div><\/div>$/, "");
	return html
		.replace(
			/<aside class="sidebar">[\s\S]*?<\/aside>/,
			`<header class="access-header"><a class="brand" href="/" aria-label="Umiak home">${brand}</a>${appearance}</header>`,
		)
		.replace("<body>", '<body class="access">')
		.replace(/const menu=[\s\S]*?const themeButtons=/, "const themeButtons=");
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
