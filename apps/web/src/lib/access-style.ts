export const ACCESS_CSS = `
:root { color-scheme: light; --access-bg: #fefefe; --access-fg: #060606; --access-muted: #4d4d4d; }
:root.dark { color-scheme: dark; --access-bg: #060606; --access-fg: #fefefe; --access-muted: #a3a3a3; }
body { background: var(--access-bg); color: var(--access-fg); margin: 0; }
.umiak-access { font-family: Inter, system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 2rem; }
.umiak-access a { color: inherit; }
.umiak-access svg { height: 32px; width: auto; margin-bottom: 2rem; }
.umiak-access h1 { font-size: 1.25rem; font-weight: 600; }
.umiak-access p { color: var(--access-muted); line-height: 1.6; }
`;
