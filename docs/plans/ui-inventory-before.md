# UI source inventory — before

Counts outside components/ui: {"raw button": 10, "raw select": 9, "raw input": 16, "raw textarea": 6, "hex": 7, "radius": 39}

## apps/web/src/app/(app)/app/operator/forbidden.tsx

```text
L6 h1 className="text-xl font-semibold">
L12 a className="underline" href="/app">
```

## apps/web/src/app/(app)/app/page.tsx

```text
L20 h1 className="text-xl font-semibold">
```

## apps/web/src/app/(app)/forbidden.tsx

```text
L33 h1 className="text-xl font-semibold">
L37 a className="underline" href="/app">
```

## apps/web/src/app/(app)/unauthorized.tsx

```text
L6 h1 className="text-xl font-semibold">
```

## apps/web/src/components/admin/delete-team-button.tsx

```text
L69 Button buttonStyle="secondary" size="medium" margin={false} disabled={busy} onClick={check} id="umiak-delete-team" >
```

## apps/web/src/components/admin/json-field.tsx

```text
L50 textarea id={`field-${path.replace(/\./g, "__")}`} value={text} readOnly={disabled} spellCheck={false} rows={Math.min(Math.max(text.split("\n").length, 3), 20)} style={{ width: "100%", fontFamily: "var(--font-mono, monospace)", fontSize: "13px", pad
```

## apps/web/src/components/app/access-page.tsx

```text
L28 a href="/app" aria-label="Umiak">
```

## apps/web/src/components/app/account-settings.tsx

```text
L50 section className={plain ? "space-y-3" : "dashboard-card space-y-3"}>
L70 h1 className="text-xl font-semibold">
L71 section className="dashboard-card space-y-5">
L75 Button asChild variant="ghost">
L76 a href={signOutHref} title="Ends the single sign-on session too; the CLI will ask for umiak login again." >
L114 Badge variant="secondary">
L140 Select value={s.defaultTeamId} disabled={pending} onValueChange={(teamId) =>
L155 SelectTrigger className="w-full max-w-72" aria-label="Default team">
L257 Table >
L279 ConfirmButton title={`Delete ${k.name}?`} description="The key stops working for new SSH logins at once; open sessions stay." confirmLabel="Delete" variant="ghost" onConfirm={() =>
L294 form onSubmit={submit} className="max-w-2xl space-y-2">
L295 Input aria-label="Key name" placeholder="Name, e.g. laptop" required value={name} onChange={(e) =>
L302 textarea aria-label="Public key" placeholder="ssh-ed25519 AAAA… me@laptop" required rows={3} spellCheck={false} className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:border-ring fo
L317 Button type="submit" disabled={ add.isPending || name.trim() === "" || publicKey.trim() === "" } >
```

## apps/web/src/components/app/app-shell.tsx

```text
L110 DropdownMenu >
L112 Button variant="outline" className="w-full justify-between" data-testid="team-switcher" >
L119 Badge variant="secondary">
L127 Link href={switchTeamPath(pathname, t.id)}>
L140 Link href="/app/teams/new">
L147 Link href="/app" className="dashboard-brand" aria-label="Umiak">
L156 Button key={n.label} asChild variant={active(n.section) ? "secondary" : "ghost"} size="sm" >
L162 Link href={ singleOwner && n.section === undefined ? "/app" : teamPath(team.id, n.section) } onClick={() =>
L177 Button asChild variant={pathname === "/app/templates" ? "secondary" : "ghost"} size="sm" >
L182 Link href="/app/templates" onClick={() =>
L192 Button asChild variant={pathname === "/app/getting-started" ? "secondary" : "ghost"} size="sm" >
L197 Link href="/app/getting-started" onClick={() =>
L209 Button asChild variant={pathname === "/app/settings" ? "secondary" : "ghost"} size="sm" >
L214 Link href="/app/settings" onClick={() =>
L225 Button asChild variant={pathname === "/app/account" ? "secondary" : "ghost"} size="sm" >
L230 Link href="/app/account" onClick={() =>
L239 Button asChild variant={active("settings") ? "secondary" : "ghost"} size="sm" >
L244 Link onClick={() =>
L259 Button asChild variant="ghost" size="sm">
L260 a href="/setup">
L262 Button asChild variant="ghost" size="sm">
L263 a href="/owner/sessions">
L269 Button asChild variant={pathname === "/app/operator" ? "secondary" : "ghost"} size="sm" >
L274 Link href="/app/operator" aria-current={pathname === "/app/operator" ? "page" : undefined} >
L281 Button asChild variant="ghost" size="sm">
L283 a href="/admin">
L288 DropdownMenu >
L290 Button variant="ghost" size="sm" data-testid="user-menu">
L304 Link href="/app/account">
L307 Tooltip >
L311 a href={signOutHref(logoutUrl)}>
L329 a href="#dashboard-content" className="dashboard-skip">
L333 Link href="/app" className="dashboard-brand" aria-label="Umiak">
L337 Button variant="ghost" size="icon" aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="dashboard-mobile-navigation" onClick={() =>
L356 Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
L357 DialogContent className="dashboard-drawer" placement="left" id="dashboard-mobile-navigation" >
L386 Button variant={!dark ? "secondary" : "ghost"} aria-pressed={!dark} onClick={() =>
L394 Button variant={dark ? "secondary" : "ghost"} aria-pressed={dark} onClick={() =>
```

## apps/web/src/components/app/confirm-button.tsx

```text
L41 Dialog open={open} onOpenChange={(o) =>
L43 Button size={size} variant={variant} disabled={disabled} aria-label={ariaLabel} title={ariaLabel} >
L53 DialogContent >
L60 Button variant="outline" disabled={busy}>
L64 Button variant="destructive" disabled={busy} onClick={async () =>
```

## apps/web/src/components/app/copy-button.tsx

```text
L12 Button type="button" size="icon-sm" variant="ghost" aria-label={label} title={label} onClick={async () =>
L40 CopyButton text={text} label={label} />
```

## apps/web/src/components/app/deployment-settings.tsx

```text
L11 h1 className="text-xl font-semibold">
L13 section className="dashboard-card space-y-3">
L20 Button asChild variant="outline">
L21 Link href={teamPath(teamId, "keys")}>
L23 Button asChild variant="outline">
L24 Link href={teamPath(teamId, "environments")}>
```

## apps/web/src/components/app/form-dialog.tsx

```text
L49 Dialog open={open} onOpenChange={(o) =>
L50 DialogContent >
L51 form method="post" onSubmit={submit} className="grid gap-4">
L61 Button type="button" variant="outline" disabled={busy}>
L65 Button type="submit" variant={destructive ? "destructive" : "default"} disabled={busy || submitDisabled} >
L93 label className="grid gap-1 text-sm">
```

## apps/web/src/components/app/new-team-form.tsx

```text
L27 section className="dashboard-card max-w-md space-y-4">
L29 h1 className="text-xl font-semibold">
L35 form onSubmit={submit} className="space-y-3">
L36 Input aria-label="Team name" placeholder="Team name" required maxLength={64} value={name} onChange={(e) =>
L49 Button type="submit" disabled={pending || name.trim() === ""}>
```

## apps/web/src/components/app/query-error.tsx

```text
L22 Button size="xs" variant="outline" onClick={onRetry}>
```

## apps/web/src/components/app/team-notices.tsx

```text
L134 input type="checkbox" className="size-4" aria-label={`Select key ${k.name}`} disabled={k.revoked || !canRevoke} checked={!k.revoked && selected.has(k.id)} onChange={(e) =>
L144 Badge variant="secondary">
L151 ConfirmButton title="Revoke the selected keys?" description="They stop working at once on every server. This cannot be undone." confirmLabel="Revoke" variant="destructive" disabled={live.filter((k) =>
L163 Button size="sm" variant="outline" disabled={dismissing} onClick={dismiss} >
```

## apps/web/src/components/app/team-settings.tsx

```text
L68 h1 >
L98 section className="dashboard-card space-y-3">
L134 Badge variant="secondary">
L137 form onSubmit={submit} className="flex max-w-md gap-2 pt-2">
L138 Input aria-label="Team name" value={name} maxLength={64} onChange={(e) =>
L144 Button type="submit" disabled={ pending || name.trim() === "" || name.trim() === data.team.name } >
L191 QueryError error={limits.error} what="limits and usage" />
L194 Table className="max-w-md">
L230 Table >
L255 Link href="/app/teams/new" className="underline">
L289 Badge variant="secondary" className="ml-2">
L297 Select value={member.role} disabled={pending} onValueChange={(v) =>
L302 SelectTrigger size="sm" aria-label={`Role of ${member.email}`}>
L316 Badge variant="outline">
L323 ConfirmButton title={`Remove ${member.email}?`} description="Their sandboxes and the team keys they created stay with the team. Their open terminals and SSH sessions in this team are closed." confirmLabel="Remove" variant="ghost" onConfirm={async () =>
L369 form onSubmit={submit} className="flex max-w-xl flex-wrap gap-2">
L370 Input type="email" required placeholder="Email" aria-label="Email to invite" className="w-72" value={email} onChange={(e) =>
L379 Select value={role} onValueChange={(v) =>
L380 SelectTrigger aria-label="Role of the new member">
L388 Button type="submit" disabled={pending || email.trim() === ""}>
L404 ConfirmButton title={`Leave ${data.team.name}?`} description="You lose access to its sandboxes, snapshots and keys. An owner can invite you again." confirmLabel="Leave" variant="destructive" onConfirm={async () =>
```

## apps/web/src/components/ui/dialog.tsx

```text
L77 Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" >
L122 Button variant="outline">
```

## apps/web/src/components/ui/input.tsx

```text
L6 input type={type} data-slot="input" className={cn( "h-[var(--control-height)] w-full min-w-0 rounded-none border border-input bg-background px-4 py-1 text-sm outline-none placeholder:text-[#9e9e9e] focus-visible:outline-2 focus-visible:outline-of
```

## apps/web/src/features/create/create-form.tsx

```text
L261 Dialog open onOpenChange={(open) =>
L267 DialogContent className="create-dialog">
L268 section className="min-w-0 space-y-4">
L271 h1 >
L278 QueryError error={templates.error} what="templates" onRetry={() =>
L284 form method="post" onSubmit={submit} className="min-w-0 space-y-3" autoComplete="off" data-testid="create-form" >
L293 label className="flex items-center gap-1.5">
L294 input type="radio" checked={form.source === "template"} onChange={() =>
L301 label className="flex items-center gap-1.5">
L302 input type="radio" checked={form.source === "snapshot"} disabled={readySnapshots.length === 0} onChange={() =>
L318 Select value={form.snapshot} onValueChange={(v) =>
L322 SelectTrigger aria-label="Saved snapshot" className="w-56" >
L363 label key={t.slug} className="flex items-center gap-1.5">
L364 input type="radio" checked={form.template === t.slug} onChange={() =>
L395 Select value={form.size} onValueChange={(v) =>
L400 SelectTrigger aria-label="Size" className="w-80">
L436 Input aria-label="Name" placeholder="ci-run-42" className="w-80" maxLength={255} aria-invalid={errors.name !== undefined} value={form.name} onChange={(e) =>
L454 Input aria-label="Slug" placeholder="auto: three words" className="w-80 font-mono" spellCheck={false} aria-invalid={slugHint !== null || errors.slug !== undefined} value={form.slug} onChange={(e) =>
L476 Select value={envValue(form.environment)} onValueChange={(v) =>
L480 SelectTrigger aria-label="Environment" className="w-80">
L618 Button type="button" size="sm" variant="outline" disabled={pending} onClick={() =>
L631 Button type="button" variant="outline" onClick={() =>
L638 Button type="submit" disabled={pending}>
L662 Select value={value} onValueChange={(v) =>
L663 SelectTrigger aria-label={label} className="w-40">
```

## apps/web/src/features/create/kv-rows.tsx

```text
L56 Input aria-label={`${label} ${i + 1} name`} placeholder={keyPlaceholder} className="w-0 flex-[2] font-mono" autoComplete="off" spellCheck={false} aria-invalid={err !== undefined} value={r.key} onChange={(e) =>
L66 Input aria-label={`${label} ${i + 1} value`} placeholder={secret ? "•••" : valuePlaceholder} className="w-0 flex-[3] font-mono" type={secret && !visible ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} spellCheck={false} data
L78 Button type="button" size="icon-sm" variant="ghost" aria-label={visible ? "Hide value" : "Show value"} aria-pressed={visible} onClick={() =>
L89 Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${label} ${i + 1}`} onClick={() =>
L106 Button type="button" size="xs" variant="ghost" onClick={() =>
```

## apps/web/src/features/create/secret-files.tsx

```text
L76 Input aria-label={`Secret file ${i + 1} name`} className="w-44 font-mono" autoComplete="off" spellCheck={false} aria-invalid={errors[`${at}.name`] !== undefined} value={f.name} onChange={(e) =>
L85 Input aria-label={`Secret file ${i + 1} mode`} placeholder="0440" className="w-20 font-mono" autoComplete="off" aria-invalid={errors[`${at}.mode`] !== undefined} value={f.mode} onChange={(e) =>
L94 Input aria-label={`Secret file ${i + 1} link path`} placeholder="link path, e.g. /home/user/.config/key.json" className="w-80 font-mono" autoComplete="off" spellCheck={false} aria-invalid={errors[`${at}.linkPath`] !== undefined} value={f.linkPath
L107 Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove secret file ${f.name}`} onClick={() =>
L126 input ref={input} type="file" multiple className="sr-only" aria-label="Secret files to upload" tabIndex={-1} onChange={(e) =>
L135 Button type="button" size="xs" variant="ghost" onClick={() =>
```

## apps/web/src/features/environments/environment-dialog.tsx

```text
L70 Dialog open={open} onOpenChange={onOpenChange}>
L71 DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
L186 form method="post" onSubmit={submit} className="grid gap-5">
L207 Input aria-label="Name" placeholder="production" className="w-72 font-mono" autoComplete="off" spellCheck={false} aria-invalid={errors.name !== undefined} value={form.name} onChange={(e) =>
L219 label className="flex items-start gap-2">
L220 input type="checkbox" className="mt-0.5" checked={form.isDefault} onChange={(e) =>
L237 label className="flex items-start gap-2">
L238 input type="checkbox" className="mt-0.5" checked={form.excludeOwnerSecrets} onChange={(e) =>
L276 Badge key={k} variant="outline" className={removed ? "line-through opacity-60" : ""} >
L282 button type="button" className="ml-1 text-xs underline" onClick={() =>
L327 button type="button" className="text-xs underline" onClick={() =>
L371 Button type="button" variant="outline" disabled={busy}>
L375 Button type="submit" disabled={busy}>
```

## apps/web/src/features/environments/environments-page.tsx

```text
L83 section className="environments-page space-y-4">
L85 h1 className="text-xl font-semibold">
L93 Select value={selected.id} onValueChange={setSelectedId}>
L94 SelectTrigger aria-label="Environment" className="min-w-48 max-w-full" >
L111 Button variant="ghost" size="icon" aria-label="New environment" title="New environment" onClick={() =>
L130 QueryError error={list.error} what="environments" onRetry={() =>
L149 article key={e.id} className="environment-summary space-y-3" data-testid="environment" data-selected={e.id === selected?.id} >
L157 button type="button" className="environment-name" aria-expanded={e.id === selected?.id} onClick={() =>
L166 Badge >
L168 Badge variant="outline">
L179 Button size="icon-sm" variant="ghost" aria-label={`Edit environment ${e.name}`} title={`Edit environment ${e.name}`} onClick={() =>
L188 ConfirmButton title={`Delete environment ${e.name}?`} description="Sandboxes created from it keep their values. New creates no longer get it." confirmLabel="Delete" size="icon-sm" variant="ghost" ariaLabel={`Delete environment ${e.name}`} onConfirm={() =
L288 Badge key={n} variant="secondary" className="font-mono">
```

## apps/web/src/features/environments/repository-rows.tsx

```text
L39 Input aria-label={`Repository ${i + 1} URL`} placeholder="https://github.com/acme/web.git or git@host:org/repo.git" className="w-96 font-mono" autoComplete="off" spellCheck={false} aria-invalid={errors[`${at}.url`] !== undefined} value={r.url} on
L49 Input aria-label={`Repository ${i + 1} branch`} placeholder="branch or tag" className="w-32 font-mono" autoComplete="off" spellCheck={false} aria-invalid={errors[`${at}.branch`] !== undefined} value={r.branch} onChange={(e) =>
L59 Input aria-label={`Repository ${i + 1} path`} placeholder="path (repo name)" className="w-40 font-mono" autoComplete="off" spellCheck={false} aria-invalid={errors[`${at}.path`] !== undefined} value={r.path} onChange={(e) =>
L69 Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove repository ${i + 1}`} onClick={() =>
L88 Button type="button" size="xs" variant="ghost" disabled={rows.length >
```

## apps/web/src/features/getting-started/getting-started.tsx

```text
L49 article className="getting-started space-y-8">
L52 h1 className="text-2xl font-semibold">
L72 a key={section.id} href={`#${section.id}`} className="block py-1.5 text-sm text-muted-foreground hover:text-foreground" >
L83 section key={section.id} id={section.id} className="scroll-mt-8 space-y-4" >
L106 CopyButton label={`Copy ${block.label}`} text={block.text} />
```

## apps/web/src/features/keys/keys-page.tsx

```text
L103 section className="space-y-4">
L113 h1 className="text-xl font-semibold">
L148 QueryError error={keys.error} what="API keys" onRetry={() =>
L167 ConfirmButton title={`Rotate ${k.name}?`} description="A new secret is issued and the old one stops working at once everywhere it is used." confirmLabel="Rotate" size="xs" onConfirm={() =>
L178 ConfirmButton title={`Revoke ${k.name}?`} description="It stops working at once on every server; its open streams and terminals are closed. This cannot be undone." confirmLabel="Revoke" variant="ghost" size="xs" onConfirm={() =>
L212 Tooltip >
L235 Table >
L262 Badge variant="outline" className="ml-2 border-warning/35 text-warning" data-testid="creator-note" >
L276 Badge variant="secondary">
L280 Badge variant="secondary">
```

## apps/web/src/features/keys/new-key-form.tsx

```text
L75 form method="post" onSubmit={submit} className="key-form" aria-label={singleOwner ? "New API key" : "New team API key"} >
L82 label htmlFor="new-key-name" className="grid min-w-0 content-start gap-2" >
L87 Input id="new-key-name" aria-label="Key name" placeholder="Name, e.g. ci-main" maxLength={64} autoComplete="off" value={form.name} onChange={(e) =>
L98 label htmlFor="new-key-days" className="font-medium">
L101 Input id="new-key-days" type="number" min={1} max={KEY_DAYS_MAX} className="w-full" value={form.days} onChange={(e) =>
L121 label key={p} className="key-preset flex items-start gap-3">
L122 input type="radio" className="mt-1" checked={form.preset === p} onChange={() =>
L145 label className="key-preset flex items-center gap-3">
L146 input type="radio" checked={form.preset === "custom"} onChange={() =>
L165 label key={s} className="flex items-center gap-1.5">
L166 input type="checkbox" checked={form.scopes.includes(s)} onChange={(e) =>
L184 Button type="submit" disabled={busy}>
```

## apps/web/src/features/keys/secret-dialog.tsx

```text
L31 Dialog open={shown !== null} onOpenChange={(o) =>
L38 DialogContent className="sm:max-w-2xl" showCloseButton={false} data-testid="key-secret-dialog" // Neither a click outside nor Escape may lose a secret that is // shown only once: it closes through "I have copied it" only. onInteractOutside={(e) =>
L64 CopyButton text={shown.secret} label="Copy the secret" />
L79 CopyButton text={line} label="Copy the command" />
L84 Button onClick={onClose}>
```

## apps/web/src/features/operator/block-dialog.tsx

```text
L34 textarea aria-label="Note" rows={3} maxLength={MAX_BLOCK_NOTE + 100} className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value=
L80 Select value={reason} onValueChange={(v) =>
L84 SelectTrigger aria-label="Reason" className="w-full">
```

## apps/web/src/features/operator/operator-actions.tsx

```text
L58 Button size="xs" variant="ghost" aria-expanded={portsOpen} onClick={onTogglePorts} >
L67 Button size="xs" variant="outline" disabled={busy} onClick={() =>
L76 Button size="xs" variant="outline" disabled={busy || !canDelete(sandbox)} onClick={() =>
L85 Button size="xs" variant="outline" disabled={busy || !canStop(sandbox)} onClick={stop} >
L93 Button size="xs" variant="outline" className="text-destructive" disabled={busy || !canDelete(sandbox)} onClick={() =>
```

## apps/web/src/features/operator/operator-page.tsx

```text
L101 section className="space-y-4">
L103 h1 className="text-xl font-semibold">
L108 Button asChild variant="outline" className="ml-auto">
L110 a href="/admin">
L114 Input aria-label="Search name or slug" placeholder="Search name/slug" className="w-56" value={q} onChange={(e) =>
L121 Select value={teamId} onValueChange={setTeamId}>
L122 SelectTrigger aria-label="Team" className="w-56">
L135 Select value={state} onValueChange={(v) =>
L139 SelectTrigger aria-label="State" className="w-36">
L153 QueryError error={list.error} what="sandboxes" onRetry={() =>
L179 Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() =>
L206 Table data-testid="operator-table">
L223 Link href={teamPath(s.teamId)} className="hover:underline" title={s.teamId} >
L232 Link href={sandboxHref(s.teamId, s.slug)} className="flex items-center gap-1 font-medium hover:underline" >
```

## apps/web/src/features/operator/port-blocks.tsx

```text
L35 Dialog >
L48 QueryError error={ports.error} what="ports" onRetry={() =>
L82 Button size="xs" variant="outline" onClick={() =>
L92 Button size="xs" variant="outline" onClick={() =>
```

## apps/web/src/features/operator/sandbox-management.tsx

```text
L23 section className="border bg-muted/20 p-4 space-y-3" aria-label="Sandbox management" >
L29 Button variant="outline" size="sm" disabled={!canDelete(sandbox)} onClick={() =>
L37 Button variant="ghost" size="sm" aria-expanded={ports} onClick={() =>
```

## apps/web/src/features/sandbox/commands.tsx

```text
L111 select aria-label="Status" className="h-8 rounded-lg border bg-transparent px-2 text-sm" value={status} onChange={(e) =>
L124 Button size="sm" className="ml-auto" disabled={!work.ok} title={work.ok ? undefined : work.reason} onClick={() =>
L135 QueryError error={list.error} what="commands" onRetry={() =>
L148 Table data-testid="commands-table">
L181 button type="button" className="block w-full truncate text-left font-mono text-xs hover:underline" >
L218 Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() =>
L350 textarea className="min-h-16 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-sm" spellCheck={false} value={cmd} placeholder="npm test" onChange={(e) =>
L360 Input value={cwd} spellCheck={false} onChange={(e) =>
L367 Input value={user} spellCheck={false} onChange={(e) =>
L379 textarea className="min-h-14 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs" spellCheck={false} autoComplete="off" value={envText} onChange={(e) =>
L392 Input inputMode="numeric" value={timeout} onChange={(e) =>
```

## apps/web/src/features/sandbox/desktop.tsx

```text
L63 Button disabled={busy || !headerActions(sandbox).resume} onClick={async () =>
L80 Button variant="outline" onClick={async () =>
L94 Button variant="outline" disabled={!url} onClick={() =>
L105 label className="text-sm">
L107 select aria-label="Desktop access" className="rounded border p-1" value={status.data?.access ?? "token"} disabled={busy || !status.data} onChange={async (event) =>
L130 ConfirmButton variant="outline" title="Disconnect all desktop viewers?" description="Active desktop streams will close." confirmLabel="Disconnect" onConfirm={async () =>
L147 QueryError error={status.error} what="desktop access" onRetry={() =>
L154 QueryError error={error} what="desktop" onRetry={refresh} />
```

## apps/web/src/features/sandbox/env.tsx

```text
L87 QueryError error={q.error} what="env" onRetry={() =>
L111 section className="space-y-2">
L114 Button size="sm" variant="outline" className="ml-auto" disabled={off} onClick={() =>
L124 Table data-testid="env-table">
L161 section className="space-y-2">
L164 Button size="sm" variant="outline" className="ml-auto" disabled={off} onClick={() =>
L174 Table data-testid="secrets-table">
L203 section className="space-y-2">
L206 Button size="sm" variant="outline" className="ml-auto" disabled={off} onClick={() =>
L216 Table >
L239 ConfirmButton size="xs" variant="ghost" title={`Remove ${f.name}?`} description="The file is removed from the sandbox's secret files." confirmLabel="Remove" disabled={off} onConfirm={() =>
L301 Button size="xs" variant="ghost" disabled={off} onClick={onEdit}>
L304 ConfirmButton size="xs" variant="ghost" title={`Remove ${what}?`} description="New commands no longer see it." confirmLabel="Remove" disabled={off} onConfirm={onDelete} >
L376 Input autoFocus spellCheck={false} autoComplete="off" value={name} onChange={(e) =>
L388 Input type={show ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={v} onChange={(e) =>
L395 Button type="button" size="sm" variant="ghost" onClick={() =>
L405 textarea className="min-h-16 rounded-lg border bg-transparent px-2.5 py-1.5 font-mono text-xs" spellCheck={false} value={v} onChange={(e) =>
L490 input type="file" onChange={(e) =>
L500 Input spellCheck={false} value={name} onChange={(e) =>
L508 Input spellCheck={false} placeholder="0440" value={mode} onChange={(e) =>
L520 Input spellCheck={false} placeholder="/home/user/.config/key.json" value={link} onChange={(e) =>
```

## apps/web/src/features/sandbox/files.tsx

```text
L152 QueryError error={home.error} what="the home directory" onRetry={() =>
L240 section aria-label="Files; drop files here to upload them" className={cn( "space-y-3 rounded-lg", dragging && "outline-2 outline-dashed outline-primary", )} onDragOver={(e) =>
L262 button type="button" className="rounded px-0.5 hover:underline" onClick={() =>
L273 label className="flex items-center gap-1 text-sm">
L274 input type="checkbox" checked={hidden} onChange={(e) =>
L281 input ref={picker} type="file" multiple hidden onChange={(e) =>
L292 Button size="sm" variant="outline" disabled={!work.ok} title={work.ok ? "Or drop files here" : work.reason} onClick={() =>
L301 Button size="sm" variant="outline" disabled={!work.ok} onClick={() =>
L309 Button size="sm" variant="outline" onClick={() =>
L319 QueryError error={list.error} what="the directory" onRetry={() =>
L325 Table data-testid="files-table">
L340 button type="button" className="font-mono hover:underline" onClick={() =>
L353 button type="button" className="flex items-center gap-1.5 font-mono text-sm hover:underline" onClick={() =>
L394 Button asChild size="xs" variant="ghost">
L395 a href={fileDownloadUrl({ sandboxId: sandbox.id, path: f.path, teamId, })} download={f.name} >
L407 Button size="xs" variant="ghost" disabled={!work.ok} onClick={() =>
L415 ConfirmButton size="xs" variant="ghost" title={`Delete ${f.name}?`} description={ f.type === "dir" ? `${f.path} and everything in it are deleted. This cannot be undone.` : `${f.path} is deleted. This cannot be undone.` } confirmLabel="Delete" disabled={!
L454 Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() =>
L517 Button size="xs" variant="ghost" onClick={() =>
L535 Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() =>
L587 Dialog open={file !== null} onOpenChange={(o) =>
L589 DialogContent className="sm:max-w-4xl">
L594 a className="underline" href={fileDownloadUrl({ sandboxId: handle.id, path: file.path, teamId, })} download={file.name} >
L669 Input autoFocus spellCheck={false} placeholder={file?.name} value={to} onChange={(e) =>
L715 Input autoFocus spellCheck={false} value={name} onChange={(e) =>
```

## apps/web/src/features/sandbox/header.tsx

```text
L104 Link href={teamPath(teamId)} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" >
L112 h1 className="sandbox-detail-heading flex items-center gap-2 font-semibold">
L114 Button size="icon-xs" variant="ghost" aria-label="Rename slug" title="Rename slug" disabled={!a.rename} onClick={() =>
L130 CopyButton text={s.id} label="Copy sandbox ID" />
L134 Button variant="ghost" disabled={s.state !== "ready" || s.blocked} onClick={() =>
L148 Button variant="ghost" disabled={s.state !== "ready" || s.blocked} onClick={() =>
L160 Button size="default" variant="ghost" disabled={busy || !a.resume} onClick={() =>
L177 Button size="default" variant="ghost" disabled={busy || !a.stop} onClick={() =>
L191 Button size="default" variant="ghost" disabled={busy || !a.fork} onClick={async () =>
L207 ConfirmButton size="default" variant="ghost" title={`Recover ${s.slug}?`} description="Recover restarts the VM (a power cycle): running commands and terminals end, files on disk stay." confirmLabel="Recover" disabled={busy || !a.recover} onConfirm={() =>
L223 Button size="default" variant="ghost" disabled={busy || !a.extend} title={ s.ttlSeconds === null && s.deadlineAt === null ? "The sandbox has no TTL" : undefined } onClick={() =>
L237 Button size="default" variant="ghost" disabled={busy || !a.saveSnapshot} onClick={() =>
L246 Button size="default" variant="destructive" className="basis-full justify-start" disabled={busy || !a.delete} onClick={() =>
L323 Link className="underline" href={teamPath(teamId, "snapshots")}>
L336 Link className="underline" href={sandboxHref(teamId, o.sandboxId)}>
L468 Button size="sm" variant="outline" disabled={busy} onClick={onRecover}>
L529 Input value={slug} autoComplete="off" spellCheck={false} aria-invalid={problem !== null} onChange={(e) =>
L588 select className="h-8 rounded-lg border bg-transparent px-2 text-sm" value={choice} onChange={(e) =>
L714 Input value={name} autoComplete="off" spellCheck={false} onChange={(e) =>
```

## apps/web/src/features/sandbox/output-view.tsx

```text
L121 select aria-label="Streams" className="h-7 rounded-md border bg-transparent px-1 text-xs" value={filter} onChange={(e) =>
L133 select aria-label="From" className="h-7 rounded-md border bg-transparent px-1 text-xs" value={from} onChange={(e) =>
L144 Button size="xs" variant="outline" onClick={() =>
L154 select aria-label="Send a signal" className="h-7 rounded-md border bg-transparent px-1 text-xs" value="" disabled={busy || controlOff !== null} title={controlOff ?? undefined} onChange={(e) =>
L172 Button size="xs" variant="destructive" disabled={busy || controlOff !== null} title={controlOff ?? undefined} onClick={kill} >
L221 select aria-label="Stream to download" className="h-7 rounded-md border bg-transparent px-1" value={stream} onChange={(e) =>
L234 Input aria-label="Offset" className="h-7 w-28 text-xs" inputMode="numeric" placeholder={String(dflt)} value={offset} onChange={(e) =>
L243 a className="underline" href={outputDownloadUrl({ sandboxId, commandId: c.id, stream, offset: at, teamId, })} download={`${c.id}.${stream}.log`} >
```

## apps/web/src/features/sandbox/overview.tsx

```text
L47 section className="space-y-2">
L76 CopyLine text={s.endpoints.portUrlTemplate} label="Copy the port URL template" />
L81 CopyLine text={s.endpoints.ssh} label="Copy the SSH command" />
L83 section className="space-y-4">
L87 button type="button" className="ml-auto text-xs underline" onClick={() =>
L96 QueryError error={commands.error} what="commands" />
L127 button type="button" className="ml-auto text-xs underline" onClick={() =>
L135 QueryError error={ports.error} what="ports" />
L143 a href={p.url} target="_blank" rel="noopener noreferrer" className="flex-1 truncate font-mono text-xs underline" >
```

## apps/web/src/features/sandbox/ports.tsx

```text
L110 QueryError error={ports.error} what="ports" onRetry={() =>
L116 section className="space-y-2">
L119 Button size="sm" variant="outline" className="ml-auto" disabled={!gate.ok} title={gate.ok ? undefined : gate.reason} onClick={() =>
L150 a href={p.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-1 truncate font-mono text-xs underline" >
L168 Button asChild size="xs" variant="outline">
L169 a href={p.url} target="_blank" rel="noopener noreferrer">
L173 CopyButton text={p.url} label="Copy URL" />
L174 Button size="xs" variant="outline" disabled={!gate.ok || p.blocked} onClick={() =>
L185 ConfirmButton size="xs" title={`Rotate the token of port ${p.port}?`} description="The old token and its cookies stop working at once; the new one is shown once." confirmLabel="Rotate" disabled={!gate.ok || p.blocked} onConfirm={() =>
L196 ConfirmButton size="xs" title={`Unpublish port ${p.port}?`} description="The URL stops working at once; the app in the sandbox keeps running." confirmLabel="Unpublish" disabled={!gate.ok || p.blocked} onConfirm={async () =>
L217 section className="space-y-2">
L236 Button size="xs" variant="outline" className="ml-auto" disabled={!gate.ok} onClick={() =>
L367 Input inputMode="numeric" autoFocus value={port} onChange={(e) =>
L380 label key={a} className={ a === "public" && publicOff ? "text-muted-foreground" : undefined } >
L388 input type="radio" name="access" className="mr-2" checked={access === a} disabled={a === "public" && publicOff} onChange={() =>
L405 select className="h-8 rounded-lg border bg-transparent px-2 text-sm" value={rewrite} onChange={(e) =>
L438 Dialog open={shown !== null} onOpenChange={(o) =>
L440 DialogContent className="sm:max-w-2xl" showCloseButton={false} data-testid="port-token-dialog" onInteractOutside={(e) =>
L458 CopyLine text={shown.urlWithToken} label="Copy the link with the token" />
L463 CopyLine text={shown.token} label="Copy the token" />
L465 Button onClick={onClose}>
```

## apps/web/src/features/sandbox/sandbox-page.tsx

```text
L102 section className="space-y-3">
L103 Link href={teamPath(teamId)} className="text-sm text-muted-foreground hover:underline" >
L117 QueryError error={live.error} what="the sandbox" onRetry={() =>
L131 section className="space-y-4">
L140 QueryError error={live.error} what="the latest state" onRetry={() =>
L151 Tabs value={tab} onValueChange={(v) =>
```

## apps/web/src/features/sandbox/ssh.tsx

```text
L36 QueryError error={q.error} what="SSH access" onRetry={() =>
L57 Link href="/app/account" className="underline">
L64 section className="space-y-1">
L66 CopyLine text={s.command} label="Copy the SSH command" />
L72 section className="space-y-1">
L79 CopyLine text={s.knownHosts.join("\n")} label="Copy the known_hosts lines" />
```

## apps/web/src/features/sandbox/terminal.tsx

```text
L138 button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={cn( "rounded-md border px-2 py-1 font-mono text-xs", t.id === active ? "bg-muted font-medium" : "text-muted-foreground", )} onClick={() =>
L155 Button size="sm" variant="outline" disabled={creating} onClick={create} >
L190 Button size="sm" variant="outline" onClick={() =>
L353 Button size="xs" variant="outline" onClick={() =>
L363 Button size="xs" variant="outline" onClick={onClosed}>
L368 Button size="xs" variant="outline" title="Disconnect; the shell keeps running. The agent ends it after 10 min without a client." onClick={() =>
L379 Button size="xs" variant="outline" disabled={closing} title="End the shell (SIGTERM, then SIGKILL)" onClick={close} >
```

## apps/web/src/features/sandbox/xterm.tsx

```text
L96 Input aria-label="Search in the output" placeholder="Search" className="h-7 w-48" value={needle} onChange={(e) =>
L113 Button size="icon-xs" variant="ghost" aria-label="Previous match" disabled={needle === ""} onClick={() =>
L122 Button size="icon-xs" variant="ghost" aria-label="Next match" disabled={needle === ""} onClick={() =>
```

## apps/web/src/features/sandboxes/delete-dialog.tsx

```text
L57 Dialog open={open} onOpenChange={(o) =>
L65 DialogContent >
L66 form method="post" onSubmit={submit} className="grid gap-4">
L74 Input aria-label="Slug of the sandbox to delete" placeholder={sandbox.slug} autoComplete="off" spellCheck={false} value={typed} onChange={(e) =>
L84 Button type="button" variant="outline" disabled={busy}>
L88 Button type="submit" variant="destructive" disabled={busy || !matches} >
```

## apps/web/src/features/sandboxes/force-stop.tsx

```text
L46 Dialog open={answer !== null} onOpenChange={(o) =>
L52 DialogContent >
L58 Button variant="outline" onClick={() =>
L61 Button variant="destructive" onClick={() =>
```

## apps/web/src/features/sandboxes/row-actions.tsx

```text
L86 Button asChild size="icon-sm" variant="ghost">
L87 Link href={sandboxHref(teamId, sandbox.slug)} aria-label={`Open ${sandbox.name ?? sandbox.slug}`} >
L94 DropdownMenu >
L96 Button size="icon-sm" variant="ghost" aria-label={`Actions of ${sandbox.slug}`} disabled={busy} >
L133 Link href={sandboxHref(teamId, sandbox.slug, "terminal")}>
```

## apps/web/src/features/sandboxes/sandbox-list.tsx

```text
L113 section className="sandbox-list space-y-4">
L115 h1 className="text-xl font-semibold">
L117 Button asChild className="ml-auto">
L118 Link href={teamPath(teamId, "sandboxes/new")}>
L125 Input aria-label="Search name or slug" placeholder="Search name or slug" className="w-80 max-w-full" value={q} onChange={(e) =>
L132 Select value={state} onValueChange={(v) =>
L136 SelectTrigger aria-label="State">
L149 Input aria-label="Label filter" placeholder="label: k=v (Enter)" className="w-56" aria-invalid={labelError !== null} value={labelText} onChange={(e) =>
L167 QueryError error={list.error} what="sandboxes" onRetry={() =>
L177 EmptyState teamId={teamId} filtered={filtered} />
L234 Link href="/app/getting-started#install">
L238 Link href="/app/getting-started#first-sandbox">
L244 Link href="/app/getting-started#agents">
L247 Button asChild>
L248 Link href={teamPath(teamId, "sandboxes/new")}>
L302 Table data-testid="sandbox-table">
L319 Link href={sandboxHref(teamId, s.slug)} className="sandbox-row-name" >
L338 CopyButton text={s.id} label="Copy sandbox ID" />
L375 article key={s.id} className="sandbox-card" data-testid="sandbox-card" >
L381 Link href={sandboxHref(teamId, s.slug)} className="sandbox-row-name" >
L396 CopyButton text={s.id} label="Copy sandbox ID" />
L444 Button variant="outline" size="sm" disabled={loading} onClick={onLoad}>
```

## apps/web/src/features/sandboxes/state-cell.tsx

```text
L31 Tooltip >
L69 Tooltip >
L72 Badge variant="destructive">
L108 Tooltip >
L111 Badge className="bg-warning-tint text-warning">
```

## apps/web/src/features/snapshots/snapshot-list.tsx

```text
L85 section className="space-y-4">
L87 h1 className="text-xl font-semibold">
L103 QueryError error={snapshots.error} what="snapshots" onRetry={() =>
L116 Link href="/app/templates" className="underline">
L123 Table data-testid="snapshot-table">
L145 Link href={sandboxHref(teamId, s.sourceSandboxId)} className="font-mono text-xs hover:underline" >
L173 Button asChild size="xs" variant="outline">
L174 Link href={newSandboxHref(teamId, { snapshot: s.name })} >
L182 ConfirmButton title={`Delete snapshot ${s.name}?`} description="Sandboxes created from it keep running. This cannot be undone." confirmLabel="Delete" variant="ghost" size="xs" onConfirm={() =>
L216 Tooltip >
L219 Badge variant="destructive">
```

## apps/web/src/features/templates/template-list.tsx

```text
L86 section className="space-y-5">
L87 h1 className="text-xl font-semibold">
L90 Link href={teamPath(teamId, "snapshots")} className="underline">
L103 QueryError error={templates.error} what="templates" onRetry={() =>
L129 article key={t.slug} data-testid="template-card" className="space-y-4 rounded-lg border p-5" >
L136 Badge variant={status === "failed" ? "destructive" : "secondary"} >
L181 Button size="sm" variant="outline" disabled={busy} onClick={async () =>
L205 Button size="sm" variant="outline" disabled={job?.status === "running"} onClick={() =>
L221 Button asChild size="sm" variant="outline">
L222 Link href="/app/getting-started">
L234 QueryError error={jobs.error} what="build progress" onRetry={() =>
L273 Dialog open={selected !== null} onOpenChange={(open) =>
L279 DialogContent className="max-h-[90vh] overflow-auto">
L284 form id="template-build-form" className="space-y-4" onSubmit={async (event) =>
L325 label className="block text-sm">
L327 select name="mediaStorage" className="mt-1 block w-full border bg-background p-2" aria-label="ISO storage" >
L340 label htmlFor="tpl-isoUrl" className="block text-sm">
L342 Input id="tpl-isoUrl" name="isoUrl" type="url" placeholder="https://…/windows.iso" />
L349 label htmlFor="tpl-iso" className="block text-sm">
L351 Input id="tpl-iso" name="iso" placeholder="local:iso/windows.iso" />
L357 label htmlFor="tpl-isoSha256" className="block text-sm">
L359 Input id="tpl-isoSha256" name="isoSha256" pattern="[a-fA-F0-9]{64}" />
L365 label htmlFor="tpl-virtioUrl" className="block text-sm">
L367 Input id="tpl-virtioUrl" name="virtioUrl" defaultValue="https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso" />
L373 label htmlFor="tpl-virtioSha256" className="block text-sm">
L375 Input id="tpl-virtioSha256" name="virtioSha256" pattern="[a-fA-F0-9]{64}" />
L381 label className="flex gap-2 text-sm">
L382 input name="allowInternalIsoUrls" type="checkbox" />
L388 Button type="button" variant="outline" disabled={busy} onClick={async () =>
L434 label className="flex gap-2 text-sm">
L435 input type="checkbox" required />
L438 Button type="submit" disabled={busy}>
```

## Global CSS selectors

```css
/* Customer dashboard only; Payload admin has its own root layout. */
@import "tailwindcss";
@import "tw-animate-css";
@import "@fontsource-variable/inter";
@import "@fontsource-variable/funnel-display";
@import "@fontsource/ibm-plex-mono/400.css";
@import "@fontsource/ibm-plex-mono/500.css";

@custom-variant dark (&:is(.dark *));

/* From shadcn/tailwind.css (the shadcn CLI package is not a dependency). */
/* Custom variants */
@custom-variant data-open

	&:where([data-state="open"]),
	&:where([data-open]:not([data-open="false"]))


@custom-variant data-closed

	&:where([data-state="closed"]),
	&:where([data-closed]:not([data-closed="false"]))


@custom-variant data-checked

	&:where([data-state="checked"]),
	&:where([data-checked]:not([data-checked="false"]))


@custom-variant data-unchecked

	&:where([data-state="unchecked"]),
	&:where([data-unchecked]:not([data-unchecked="false"]))


@custom-variant data-selected

	&:where([data-selected="true"])


@custom-variant data-disabled

	&:where([data-disabled="true"]),
	&:where([data-disabled]:not([data-disabled="false"]))


@custom-variant data-active

	&:where([data-state="active"]),
	&:where([data-active]:not([data-active="false"]))


@custom-variant data-horizontal

	&:where([data-orientation="horizontal"])


@custom-variant data-vertical

	&:where([data-orientation="vertical"])


@theme inline


:root

.dark

@media (min-width: 768px)

	:root


@layer base

	*

	body

	html


/* Independently implemented from the measured reference values in research/. */
html

body

.dashboard-shell

.dashboard-sidebar

.dashboard-sidebar-content

.dashboard-brand

.dashboard-brand svg

.desktop-team-switcher

.dashboard-nav

.dashboard-nav [data-slot="button"]

.dashboard-nav [aria-current="page"]

.dashboard-sidebar-footer

.dashboard-sidebar-footer > [data-testid="user-menu"]

.dashboard-theme

.dashboard-theme [data-slot="button"]

.dashboard-theme [data-slot="button"] + [data-slot="button"]

.dashboard-content

.dashboard-page

.dashboard-page > section,
.dashboard-page > div

h1

h2,
h3

.dashboard-page > .space-y-4 > :not(:last-child)

.dashboard-page > .sandbox-list > :not(:last-child)

.dashboard-card

.dashboard-card > h2,
.dashboard-card > header

.dashboard-page .border-dashed

.dashboard-empty-icon

.sandbox-detail-heading

.sandbox-title

.sandbox-actions

.sandbox-facts

.sandbox-fact

.sandbox-fact dd

.sandbox-overview

.sandbox-overview > section

.sandbox-overview h2

.sandbox-workspace

.snapshot-panel

.snapshot-panel .border-dashed

.dashboard-skip

.dashboard-skip:focus

.dashboard-mobile-header

.key-form

.key-form fieldset


.key-preset

.key-preset:has(input:checked)

.key-preset:last-child

.key-preset strong

.environment-toolbar

.environment-summary

.environment-summary dl

.environment-summary dt

.environment-summary dd

.create-dialog

.create-dialog h1

.create-dialog [data-testid="create-form"] > div

.create-dialog [data-testid="create-form"] > div:last-child

.create-dialog [data-testid="create-form"] > div > div:first-child

.create-dialog [data-testid="create-form"] > div > div:last-child

@media (max-width: 1023px)

	.dashboard-mobile-header

	.dashboard-mobile-header .dashboard-brand svg

	.dashboard-sidebar

	.dashboard-sidebar-content

	.dashboard-sidebar-content > .dashboard-brand

	.dashboard-nav

	.dashboard-nav [data-slot="button"]

	.dashboard-sidebar-footer

	.dashboard-theme

	.dashboard-content

	.sandbox-facts

@media (max-width: 639px)

	.dashboard-content

	.sandbox-facts

	.sandbox-actions

	.sandbox-workspace


.dashboard-empty

.snapshot-panel .dashboard-empty


.sandbox-cards

.sandbox-row-name

.sandbox-row-name:hover

.sandbox-desktop-table [data-slot="table-cell"]

@media (max-width: 1399px)

	.sandbox-desktop-table

	.sandbox-cards

.sandbox-card

@media (max-width: 1023px)

	.desktop-team-switcher

	.mobile-team-switcher

.create-dialog [data-slot="select-trigger"]

[data-sonner-toast]


.sandbox-title > :where(div)

[data-slot="dialog-header"]

.key-form fieldset

.key-form fieldset > label

.key-form .key-preset

.dashboard-shell *,
[data-slot="dialog-content"] *

[data-slot="dropdown-menu-content"],
[data-slot="select-content"],
[data-slot="tooltip-content"]


[data-slot="dialog-content"]

[data-slot="dialog-header"]


/* Secondary field labels measured independently from the input's text. */
.key-form label[for],
.key-form legend

.create-dialog [data-testid="create-form"] > div > div:first-child


.dashboard-drawer[data-slot="dialog-content"]

.dashboard-drawer .desktop-team-switcher

.dashboard-drawer .dashboard-sidebar-content > .dashboard-brand

.dashboard-drawer .dashboard-sidebar-footer

.dashboard-drawer .dashboard-theme


input[type="checkbox"]

input[type="checkbox"]::after

input[type="checkbox"]:checked

input[type="checkbox"]:checked::after

input[type="checkbox"]:focus-visible,
input[type="radio"]:focus-visible

input[type="radio"]


/* The display heading keeps the reference's measured -0.02em tracking. */
.dashboard-page h1:not(.sandbox-detail-heading)

[data-slot="select-trigger"] > svg


/* Acceptance fixes: preserve intrinsic content without growing the viewport. */
.dashboard-page,
.dashboard-page > *,
.dashboard-page dd,
.sandbox-overview > section,
.sandbox-workspace,
[data-slot="dialog-content"] > *,
.create-field > *

.dashboard-page dd

.sandbox-overview

.sandbox-workspace

.sandbox-row-actions [data-slot="button"] svg

[data-testid="sandbox-state"]

.sandbox-card

.sandbox-card .sandbox-row-actions

.sandbox-title > :where(div)

.sandbox-header .sandbox-actions

.key-form fieldset

.key-form label > span

.key-preset:has(input:checked) .key-preset-title

.key-intro

.key-intro h2

.environments-page > p

.environment-summary

.environment-name

.environment-summary[data-selected="true"] .environment-name

.environment-summary dt,
.environment-summary dd

.create-dialog,
.create-dialog [data-testid="create-form"],
.create-field

.create-dialog [data-testid="create-form"] > .create-field

.create-dialog [data-slot="input"],
.create-dialog [data-slot="select-trigger"]

.create-dialog .create-field label

.create-dialog p

@media (max-width: 639px)

	.sandbox-list-header > h1

	.sandbox-list-header > [data-testid="quota-line"]

	.sandbox-filters > [data-slot="input"]

	.create-dialog


/* Getting started uses the dashboard palette in both appearance modes. */
.guide-layout

.guide-toc

.onboarding-checklist

.onboarding-checklist li

.onboarding-number

.onboarding-checklist a:hover

@media (max-width: 900px)

	.guide-layout

	.guide-toc

	.onboarding-checklist
```
