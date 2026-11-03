# UI source inventory — after

Counts outside components/ui: {"raw button": 0, "raw select": 0, "raw input": 0, "raw textarea": 0, "hex": 0, "radius": 0}

## apps/web/src/app/(app)/app/operator/forbidden.tsx

```text
L13 a className="underline" href="/app">
```

## apps/web/src/app/(app)/forbidden.tsx

```text
L38 a className="underline" href="/app">
```

## apps/web/src/components/admin/delete-team-button.tsx

```text
L69 Button buttonStyle="secondary" size="medium" margin={false} disabled={busy} onClick={check} id="umiak-delete-team" >
```

## apps/web/src/components/app/access-page.tsx

```text
L28 a href="/app" aria-label="Umiak">
```

## apps/web/src/components/app/account-settings.tsx

```text
L78 Button asChild variant="ghost">
L79 a href={signOutHref} title="Ends the single sign-on session too; the CLI will ask for umiak login again." >
L117 Badge variant="secondary">
L143 Select value={s.defaultTeamId} disabled={pending} onValueChange={(teamId) =>
L158 SelectTrigger className="w-full max-w-72" aria-label="Default team">
L258 Table >
L280 ConfirmButton title={`Delete ${k.name}?`} description="The key stops working for new SSH logins at once; open sessions stay." confirmLabel="Delete" variant="ghost" onConfirm={() =>
L295 form onSubmit={submit} className="max-w-2xl space-y-2">
L296 Input aria-label="Key name" placeholder="Name, e.g. laptop" required value={name} onChange={(e) =>
L318 Button type="submit" disabled={ add.isPending || name.trim() === "" || publicKey.trim() === "" } >
```

## apps/web/src/components/app/app-shell.tsx

```text
L111 DropdownMenu >
L113 Button variant="outline" className="w-full justify-between" data-testid="team-switcher" >
L120 Badge variant="secondary">
L128 Link href={switchTeamPath(pathname, t.id)}>
L141 Link href="/app/teams/new">
L148 Link href="/app" className="dashboard-brand" aria-label="Umiak">
L163 Link href={ singleOwner && n.section === undefined ? "/app" : teamPath(team.id, n.section) } onClick={() =>
L183 Link href="/app/templates" onClick={() =>
L198 Link href="/app/getting-started" onClick={() =>
L215 Link href="/app/settings" onClick={() =>
L231 Link href="/app/account" onClick={() =>
L245 Link onClick={() =>
L261 a href="/setup">
L267 a href="/owner/sessions">
L281 Link href="/app/operator" aria-current={pathname === "/app/operator" ? "page" : undefined} >
L290 a href="/admin">
L295 DropdownMenu >
L311 Link href="/app/account">
L314 Tooltip >
L318 a href={signOutHref(logoutUrl)}>
L336 a href="#dashboard-content" className="dashboard-skip">
L340 Link href="/app" className="dashboard-brand" aria-label="Umiak">
L344 Button variant="ghost" size="icon" aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="dashboard-mobile-navigation" onClick={() =>
L363 Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
L364 DialogContent className="dashboard-drawer" placement="left" id="dashboard-mobile-navigation" >
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
L21 Button asChild variant="outline">
L22 Link href={teamPath(teamId, "keys")}>
L24 Button asChild variant="outline">
L25 Link href={teamPath(teamId, "environments")}>
```

## apps/web/src/components/app/form-dialog.tsx

```text
L50 Dialog open={open} onOpenChange={(o) =>
L51 DialogContent >
L52 form method="post" onSubmit={submit} className="grid gap-4">
L62 Button type="button" variant="outline" disabled={busy}>
L66 Button type="submit" variant={destructive ? "destructive" : "default"} disabled={busy || submitDisabled} >
L107 label className="grid gap-1 text-sm">
```

## apps/web/src/components/app/new-team-form.tsx

```text
L36 form onSubmit={submit} className="space-y-3">
L37 Input aria-label="Team name" placeholder="Team name" required maxLength={64} value={name} onChange={(e) =>
L50 Button type="submit" disabled={pending || name.trim() === ""}>
```

## apps/web/src/components/app/query-error.tsx

```text
L22 Button size="xs" variant="outline" onClick={onRetry}>
```

## apps/web/src/components/app/team-notices.tsx

```text
L144 Badge variant="secondary">
L151 ConfirmButton title="Revoke the selected keys?" description="They stop working at once on every server. This cannot be undone." confirmLabel="Revoke" variant="destructive" disabled={live.filter((k) =>
L163 Button size="sm" variant="outline" disabled={dismissing} onClick={dismiss} >
```

## apps/web/src/components/app/team-settings.tsx

```text
L136 Badge variant="secondary">
L139 form onSubmit={submit} className="flex max-w-md gap-2 pt-2">
L140 Input aria-label="Team name" value={name} maxLength={64} onChange={(e) =>
L146 Button type="submit" disabled={ pending || name.trim() === "" || name.trim() === data.team.name } >
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

## apps/web/src/components/ui/choice.tsx

```text
L10 input type="checkbox" data-slot="checkbox" className={cn( "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:outline aria-invalid:outline-destructive", className, )} {...props} />
L24 input type="radio" data-slot="radio" className={cn( "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:outline aria-invalid:outline-destructive", className, )} {...props} />
```

## apps/web/src/components/ui/dialog.tsx

```text
L77 Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" >
L122 Button variant="outline">
```

## apps/web/src/components/ui/input.tsx

```text
L10 input type={type} data-slot="input" className={cn( visuallyHidden ? "sr-only" : "h-[var(--control-height)] w-full min-w-0 rounded-none border border-input bg-background px-4 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visibl
```

## apps/web/src/components/ui/native-select.tsx

```text
L13 select data-slot="native-select" className={cn( "h-[var(--control-height)] max-w-full min-w-0 rounded-none border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-
```

## apps/web/src/components/ui/nav-item.tsx

```text
L11 Button data-nav-item="" variant={variant} size={size} className={cn( "w-full justify-start gap-2 border-0 px-3 text-muted-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-secondary-foreground", className, )} {...props} />
```

## apps/web/src/components/ui/panel.tsx

```text
L5 section data-slot="panel" className={cn( "min-w-0 rounded-none border border-border bg-card p-5 text-card-foreground", className, )} {...props} />
L46 h1 className={cn( "min-w-0", compact && "sandbox-detail-heading flex items-center gap-2", )} >
```

## apps/web/src/components/ui/textarea.tsx

```text
L8 textarea data-slot="textarea" className={cn( "min-h-20 w-full min-w-0 rounded-none border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rin
```

## apps/web/src/features/create/create-form.tsx

```text
L264 Dialog open onOpenChange={(open) =>
L270 DialogContent className="create-dialog">
L271 section className="min-w-0 space-y-4">
L281 QueryError error={templates.error} what="templates" onRetry={() =>
L287 form method="post" onSubmit={submit} className="min-w-0 space-y-3" autoComplete="off" data-testid="create-form" >
L296 label htmlFor="create-form-choice-1" className="flex items-center gap-1.5" >
L307 label htmlFor="create-form-choice-2" className="flex items-center gap-1.5" >
L327 Select value={form.snapshot} onValueChange={(v) =>
L331 SelectTrigger aria-label="Saved snapshot" className="w-56" >
L370 label htmlFor={`create-form-choice-3-${t.slug}`} key={t.slug} className="flex items-center gap-1.5" >
L406 Select value={form.size} onValueChange={(v) =>
L411 SelectTrigger aria-label="Size" className="w-80">
L447 Input aria-label="Name" placeholder="ci-run-42" className="w-80" maxLength={255} aria-invalid={errors.name !== undefined} value={form.name} onChange={(e) =>
L465 Input aria-label="Slug" placeholder="auto: three words" className="w-80 font-mono" spellCheck={false} aria-invalid={slugHint !== null || errors.slug !== undefined} value={form.slug} onChange={(e) =>
L487 Select value={envValue(form.environment)} onValueChange={(v) =>
L491 SelectTrigger aria-label="Environment" className="w-80">
L629 Button type="button" size="sm" variant="outline" disabled={pending} onClick={() =>
L642 Button type="button" variant="outline" onClick={() =>
L649 Button type="submit" disabled={pending}>
L673 Select value={value} onValueChange={(v) =>
L674 SelectTrigger aria-label={label} className="w-40">
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
L126 Input ref={input} type="file" multiple className="sr-only" aria-label="Secret files to upload" tabIndex={-1} onChange={(e) =>
L135 Button type="button" size="xs" variant="ghost" onClick={() =>
```

## apps/web/src/features/environments/environment-dialog.tsx

```text
L71 Dialog open={open} onOpenChange={onOpenChange}>
L72 DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
L187 form method="post" onSubmit={submit} className="grid gap-5">
L208 Input aria-label="Name" placeholder="production" className="w-72 font-mono" autoComplete="off" spellCheck={false} aria-invalid={errors.name !== undefined} value={form.name} onChange={(e) =>
L220 label htmlFor="environment-dialog-choice-1" className="flex items-start gap-2" >
L241 label htmlFor="environment-dialog-choice-2" className="flex items-start gap-2" >
L283 Badge key={k} variant="outline" className={removed ? "line-through opacity-60" : ""} >
L289 Button variant="ghost" size="sm" type="button" className="ml-1 text-xs underline" onClick={() =>
L336 Button variant="ghost" size="sm" type="button" className="text-xs underline" onClick={() =>
L382 Button type="button" variant="outline" disabled={busy}>
L386 Button type="submit" disabled={busy}>
```

## apps/web/src/features/environments/environments-page.tsx

```text
L85 section className="environments-page space-y-4">
L93 Select value={selected.id} onValueChange={setSelectedId}>
L94 SelectTrigger aria-label="Environment" className="min-w-48 max-w-full" >
L111 Button variant="default" size="icon" aria-label="New environment" title="New environment" onClick={() =>
L130 QueryError error={list.error} what="environments" onRetry={() =>
L147 article key={e.id} className="environment-summary space-y-3" data-testid="environment" data-selected={e.id === selected?.id} >
L155 Button variant="ghost" size="sm" type="button" className="environment-name" aria-expanded={e.id === selected?.id} onClick={() =>
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
L51 article className="getting-started space-y-8">
L74 a key={section.id} href={`#${section.id}`} className="block text-sm text-link underline underline-offset-4" >
L85 section key={section.id} id={section.id} className="scroll-mt-8 space-y-4" >
L108 CopyButton label={`Copy ${block.label}`} text={block.text} />
```

## apps/web/src/features/keys/keys-page.tsx

```text
L105 section className="space-y-4">
L148 QueryError error={keys.error} what="API keys" onRetry={() =>
L165 ConfirmButton title={`Rotate ${k.name}?`} description="A new secret is issued and the old one stops working at once everywhere it is used." confirmLabel="Rotate" size="xs" onConfirm={() =>
L176 ConfirmButton title={`Revoke ${k.name}?`} description="It stops working at once on every server; its open streams and terminals are closed. This cannot be undone." confirmLabel="Revoke" variant="ghost" size="xs" onConfirm={() =>
L210 Tooltip >
L233 Table >
L260 Badge variant="outline" className="ml-2 border-warning/35 text-warning" data-testid="creator-note" >
L274 Badge variant="secondary">
L278 Badge variant="secondary">
```

## apps/web/src/features/keys/new-key-form.tsx

```text
L76 form method="post" onSubmit={submit} className="key-form" aria-label={singleOwner ? "New API key" : "New team API key"} >
L83 label htmlFor="new-key-name" className="grid min-w-0 content-start gap-2" >
L88 Input id="new-key-name" aria-label="Key name" placeholder="Name, e.g. ci-main" maxLength={64} autoComplete="off" value={form.name} onChange={(e) =>
L99 label htmlFor="new-key-days" className="font-medium">
L102 Input id="new-key-days" type="number" min={1} max={KEY_DAYS_MAX} className="w-full" value={form.days} onChange={(e) =>
L122 label htmlFor={`new-key-form-choice-1-${p}`} key={p} className="key-preset flex items-start gap-3" >
L150 label htmlFor="new-key-form-choice-2" className="key-preset flex items-center gap-3" >
L173 label htmlFor={`new-key-form-choice-3-${s}`} key={s} className="flex items-center gap-1.5" >
L196 Button type="submit" disabled={busy}>
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
L81 Select value={reason} onValueChange={(v) =>
L85 SelectTrigger aria-label="Reason" className="w-full">
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
L104 section className="space-y-4">
L111 Button asChild variant="outline" className="ml-auto">
L113 a href="/admin">
L117 Input aria-label="Search name or slug" placeholder="Search name/slug" className="w-56" value={q} onChange={(e) =>
L124 Select value={teamId} onValueChange={setTeamId}>
L125 SelectTrigger aria-label="Team" className="w-56">
L138 Select value={state} onValueChange={(v) =>
L142 SelectTrigger aria-label="State" className="w-36">
L156 QueryError error={list.error} what="sandboxes" onRetry={() =>
L164 EmptyState kind="sandboxes">
L180 Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() =>
L207 Table data-testid="operator-table">
L224 Link href={teamPath(s.teamId)} className="hover:underline" title={s.teamId} >
L233 Link href={sandboxHref(s.teamId, s.slug)} className="flex items-center gap-1 font-medium hover:underline" >
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
L127 Button size="sm" className="ml-auto" disabled={!work.ok} title={work.ok ? undefined : work.reason} onClick={() =>
L138 QueryError error={list.error} what="commands" onRetry={() =>
L149 Table data-testid="commands-table">
L182 Button variant="ghost" size="sm" type="button" className="block w-full truncate text-left font-mono text-xs hover:underline" >
L224 Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() =>
L366 Input value={cwd} spellCheck={false} onChange={(e) =>
L373 Input value={user} spellCheck={false} onChange={(e) =>
L398 Input inputMode="numeric" value={timeout} onChange={(e) =>
```

## apps/web/src/features/sandbox/desktop.tsx

```text
L64 Button disabled={busy || !headerActions(sandbox).resume} onClick={async () =>
L81 Button variant="outline" onClick={async () =>
L95 Button variant="outline" disabled={!url} onClick={() =>
L106 label htmlFor="desktop-choice-1" className="text-sm">
L132 ConfirmButton variant="outline" title="Disconnect all desktop viewers?" description="Active desktop streams will close." confirmLabel="Disconnect" onConfirm={async () =>
L149 QueryError error={status.error} what="desktop access" onRetry={() =>
L156 QueryError error={error} what="desktop" onRetry={refresh} />
```

## apps/web/src/features/sandbox/env.tsx

```text
L89 QueryError error={q.error} what="env" onRetry={() =>
L113 section className="space-y-2">
L116 Button size="sm" variant="outline" className="ml-auto" disabled={off} onClick={() =>
L126 Table data-testid="env-table">
L163 section className="space-y-2">
L166 Button size="sm" variant="outline" className="ml-auto" disabled={off} onClick={() =>
L176 Table data-testid="secrets-table">
L205 section className="space-y-2">
L208 Button size="sm" variant="outline" className="ml-auto" disabled={off} onClick={() =>
L218 Table >
L241 ConfirmButton size="xs" variant="ghost" title={`Remove ${f.name}?`} description="The file is removed from the sandbox's secret files." confirmLabel="Remove" disabled={off} onConfirm={() =>
L303 Button size="xs" variant="ghost" disabled={off} onClick={onEdit}>
L306 ConfirmButton size="xs" variant="ghost" title={`Remove ${what}?`} description="New commands no longer see it." confirmLabel="Remove" disabled={off} onConfirm={onDelete} >
L378 Input autoFocus spellCheck={false} autoComplete="off" value={name} onChange={(e) =>
L390 Input type={show ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={v} onChange={(e) =>
L397 Button type="button" size="sm" variant="ghost" onClick={() =>
L492 Input type="file" onChange={(e) =>
L502 Input spellCheck={false} value={name} onChange={(e) =>
L510 Input spellCheck={false} placeholder="0440" value={mode} onChange={(e) =>
L522 Input spellCheck={false} placeholder="/home/user/.config/key.json" value={link} onChange={(e) =>
```

## apps/web/src/features/sandbox/files.tsx

```text
L154 QueryError error={home.error} what="the home directory" onRetry={() =>
L241 section aria-label="Files; drop files here to upload them" className={cn( "space-y-3 rounded-none", dragging && "outline-2 outline-dashed outline-primary", )} onDragOver={(e) =>
L263 Button variant="ghost" size="sm" type="button" className="rounded-none px-0.5 hover:underline" onClick={() =>
L276 label htmlFor="files-choice-1" className="flex items-center gap-1 text-sm" >
L287 Input ref={picker} type="file" multiple hidden onChange={(e) =>
L298 Button size="sm" variant="outline" disabled={!work.ok} title={work.ok ? "Or drop files here" : work.reason} onClick={() =>
L307 Button size="sm" variant="outline" disabled={!work.ok} onClick={() =>
L315 Button size="sm" variant="outline" onClick={() =>
L325 QueryError error={list.error} what="the directory" onRetry={() =>
L331 Table data-testid="files-table">
L346 Button variant="ghost" size="sm" type="button" className="font-mono hover:underline" onClick={() =>
L361 Button variant="ghost" size="sm" type="button" className="flex items-center gap-1.5 font-mono text-sm hover:underline" onClick={() =>
L404 Button asChild size="xs" variant="ghost">
L405 a href={fileDownloadUrl({ sandboxId: sandbox.id, path: f.path, teamId, })} download={f.name} >
L417 Button size="xs" variant="ghost" disabled={!work.ok} onClick={() =>
L425 ConfirmButton size="xs" variant="ghost" title={`Delete ${f.name}?`} description={ f.type === "dir" ? `${f.path} and everything in it are deleted. This cannot be undone.` : `${f.path} is deleted. This cannot be undone.` } confirmLabel="Delete" disabled={!
L462 Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() =>
L525 Button size="xs" variant="ghost" onClick={() =>
L543 Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() =>
L595 Dialog open={file !== null} onOpenChange={(o) =>
L597 DialogContent className="sm:max-w-4xl">
L602 a className="underline" href={fileDownloadUrl({ sandboxId: handle.id, path: file.path, teamId, })} download={file.name} >
L675 Input autoFocus spellCheck={false} placeholder={file?.name} value={to} onChange={(e) =>
L721 Input autoFocus spellCheck={false} value={name} onChange={(e) =>
```

## apps/web/src/features/sandbox/header.tsx

```text
L106 Link href={teamPath(teamId)} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" >
L119 Button size="icon-xs" variant="ghost" aria-label="Rename slug" title="Rename slug" disabled={!a.rename} onClick={() =>
L137 CopyButton text={s.id} label="Copy sandbox ID" />
L141 Button variant="ghost" disabled={s.state !== "ready" || s.blocked} onClick={() =>
L155 Button variant="ghost" disabled={s.state !== "ready" || s.blocked} onClick={() =>
L167 Button size="default" variant="default" disabled={busy || !a.resume} onClick={() =>
L184 Button size="default" variant="ghost" disabled={busy || !a.stop} onClick={() =>
L198 Button size="default" variant="ghost" disabled={busy || !a.fork} onClick={async () =>
L214 ConfirmButton size="default" variant="ghost" title={`Recover ${s.slug}?`} description="Recover restarts the VM (a power cycle): running commands and terminals end, files on disk stay." confirmLabel="Recover" disabled={busy || !a.recover} onConfirm={() =>
L230 Button size="default" variant="ghost" disabled={busy || !a.extend} title={ s.ttlSeconds === null && s.deadlineAt === null ? "The sandbox has no TTL" : undefined } onClick={() =>
L244 Button size="default" variant="ghost" disabled={busy || !a.saveSnapshot} onClick={() =>
L253 Button size="default" variant="destructive" className="basis-full justify-start" disabled={busy || !a.delete} onClick={() =>
L330 Link className="underline" href={teamPath(teamId, "snapshots")}>
L343 Link className="underline" href={sandboxHref(teamId, o.sandboxId)}>
L475 Button size="sm" variant="outline" disabled={busy} onClick={onRecover}>
L536 Input value={slug} autoComplete="off" spellCheck={false} aria-invalid={problem !== null} onChange={(e) =>
L721 Input value={name} autoComplete="off" spellCheck={false} onChange={(e) =>
```

## apps/web/src/features/sandbox/output-view.tsx

```text
L145 Button size="xs" variant="outline" onClick={() =>
L173 Button size="xs" variant="destructive" disabled={busy || controlOff !== null} title={controlOff ?? undefined} onClick={kill} >
L235 Input aria-label="Offset" className="h-7 w-28 text-xs" inputMode="numeric" placeholder={String(dflt)} value={offset} onChange={(e) =>
L244 a className="underline" href={outputDownloadUrl({ sandboxId, commandId: c.id, stream, offset: at, teamId, })} download={`${c.id}.${stream}.log`} >
```

## apps/web/src/features/sandbox/overview.tsx

```text
L48 section className="space-y-2">
L77 CopyLine text={s.endpoints.portUrlTemplate} label="Copy the port URL template" />
L82 CopyLine text={s.endpoints.ssh} label="Copy the SSH command" />
L84 section className="space-y-4">
L88 Button variant="ghost" size="sm" type="button" className="ml-auto text-xs underline" onClick={() =>
L99 QueryError error={commands.error} what="commands" />
L130 Button variant="ghost" size="sm" type="button" className="ml-auto text-xs underline" onClick={() =>
L140 QueryError error={ports.error} what="ports" />
L148 a href={p.url} target="_blank" rel="noopener noreferrer" className="flex-1 truncate font-mono text-xs underline" >
```

## apps/web/src/features/sandbox/ports.tsx

```text
L112 QueryError error={ports.error} what="ports" onRetry={() =>
L118 section className="space-y-2">
L121 Button size="sm" variant="outline" className="ml-auto" disabled={!gate.ok} title={gate.ok ? undefined : gate.reason} onClick={() =>
L152 a href={p.url} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-1 truncate font-mono text-xs underline" >
L170 Button asChild size="xs" variant="outline">
L171 a href={p.url} target="_blank" rel="noopener noreferrer">
L175 CopyButton text={p.url} label="Copy URL" />
L176 Button size="xs" variant="outline" disabled={!gate.ok || p.blocked} onClick={() =>
L187 ConfirmButton size="xs" title={`Rotate the token of port ${p.port}?`} description="The old token and its cookies stop working at once; the new one is shown once." confirmLabel="Rotate" disabled={!gate.ok || p.blocked} onConfirm={() =>
L198 ConfirmButton size="xs" title={`Unpublish port ${p.port}?`} description="The URL stops working at once; the app in the sandbox keeps running." confirmLabel="Unpublish" disabled={!gate.ok || p.blocked} onConfirm={async () =>
L219 section className="space-y-2">
L238 Button size="xs" variant="outline" className="ml-auto" disabled={!gate.ok} onClick={() =>
L369 Input inputMode="numeric" autoFocus value={port} onChange={(e) =>
L382 label htmlFor={`ports-choice-1-${a}`} key={a} className={ a === "public" && publicOff ? "text-muted-foreground" : undefined } >
L441 Dialog open={shown !== null} onOpenChange={(o) =>
L443 DialogContent className="sm:max-w-2xl" showCloseButton={false} data-testid="port-token-dialog" onInteractOutside={(e) =>
L461 CopyLine text={shown.urlWithToken} label="Copy the link with the token" />
L466 CopyLine text={shown.token} label="Copy the token" />
L468 Button onClick={onClose}>
```

## apps/web/src/features/sandbox/sandbox-page.tsx

```text
L103 section className="space-y-3">
L104 Link href={teamPath(teamId)} className="text-sm text-muted-foreground hover:underline" >
L118 QueryError error={live.error} what="the sandbox" onRetry={() =>
L131 section className="space-y-4">
L140 QueryError error={live.error} what="the latest state" onRetry={() =>
L151 Tabs value={tab} onValueChange={(v) =>
```

## apps/web/src/features/sandbox/ssh.tsx

```text
L37 QueryError error={q.error} what="SSH access" onRetry={() =>
L58 Link href="/app/account" className="underline">
L65 section className="space-y-1">
L67 CopyLine text={s.command} label="Copy the SSH command" />
L73 section className="space-y-1">
L80 CopyLine text={s.knownHosts.join("\n")} label="Copy the known_hosts lines" />
```

## apps/web/src/features/sandbox/terminal.tsx

```text
L138 Button variant="ghost" size="sm" key={t.id} type="button" role="tab" aria-selected={t.id === active} className={cn( "rounded-none border px-2 py-1 font-mono text-xs", t.id === active ? "bg-muted font-medium" : "text-muted-foreground", )} onClick={
L157 Button size="sm" variant="outline" disabled={creating} onClick={create} >
L192 Button size="sm" variant="outline" onClick={() =>
L355 Button size="xs" variant="outline" onClick={() =>
L365 Button size="xs" variant="outline" onClick={onClosed}>
L370 Button size="xs" variant="outline" title="Disconnect; the shell keeps running. The agent ends it after 10 min without a client." onClick={() =>
L381 Button size="xs" variant="outline" disabled={closing} title="End the shell (SIGTERM, then SIGKILL)" onClick={close} >
```

## apps/web/src/features/sandbox/xterm.tsx

```text
L99 Input aria-label="Search in the output" placeholder="Search" className="h-7 w-48" value={needle} onChange={(e) =>
L116 Button size="icon-xs" variant="ghost" aria-label="Previous match" disabled={needle === ""} onClick={() =>
L125 Button size="icon-xs" variant="ghost" aria-label="Next match" disabled={needle === ""} onClick={() =>
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
L115 section className="sandbox-list space-y-4">
L120 Button asChild>
L121 Link href={teamPath(teamId, "sandboxes/new")}>
L129 Input aria-label="Search name or slug" placeholder="Search name or slug" className="w-80 max-w-full" value={q} onChange={(e) =>
L136 Select value={state} onValueChange={(v) =>
L140 SelectTrigger aria-label="State">
L153 Input aria-label="Label filter" placeholder="label: k=v (Enter)" className="w-56" aria-invalid={labelError !== null} value={labelText} onChange={(e) =>
L171 QueryError error={list.error} what="sandboxes" onRetry={() =>
L179 EmptyState teamId={teamId} filtered={filtered} />
L236 Link href="/app/getting-started#install">
L240 Link href={teamPath(teamId, "sandboxes/new")}>
L246 Link href="/app/getting-started#agents">
L249 Button asChild>
L250 Link href={teamPath(teamId, "sandboxes/new")}>
L304 Table data-testid="sandbox-table">
L321 Link href={sandboxHref(teamId, s.slug)} className="sandbox-row-name" >
L340 CopyButton text={s.id} label="Copy sandbox ID" />
L377 article key={s.id} className="sandbox-card" data-testid="sandbox-card" >
L383 Link href={sandboxHref(teamId, s.slug)} className="sandbox-row-name" >
L398 CopyButton text={s.id} label="Copy sandbox ID" />
L446 Button variant="outline" size="sm" disabled={loading} onClick={onLoad}>
```

## apps/web/src/features/sandboxes/state-cell.tsx

```text
L32 Tooltip >
L70 Tooltip >
L73 Badge variant="destructive">
L109 Tooltip >
L112 Badge className="bg-warning-tint text-warning">
```

## apps/web/src/features/snapshots/snapshot-list.tsx

```text
L87 section className="space-y-4">
L103 QueryError error={snapshots.error} what="snapshots" onRetry={() =>
L114 Link href="/app/templates" className="underline">
L121 Table data-testid="snapshot-table">
L143 Link href={sandboxHref(teamId, s.sourceSandboxId)} className="font-mono text-xs hover:underline" >
L171 Button asChild size="xs" variant="outline">
L172 Link href={newSandboxHref(teamId, { snapshot: s.name })} >
L180 ConfirmButton title={`Delete snapshot ${s.name}?`} description="Sandboxes created from it keep running. This cannot be undone." confirmLabel="Delete" variant="ghost" size="xs" onConfirm={() =>
L214 Tooltip >
L217 Badge variant="destructive">
```

## apps/web/src/features/templates/template-list.tsx

```text
L90 section className="space-y-5">
L94 Link href={teamPath(teamId, "snapshots")} className="underline">
L107 QueryError error={templates.error} what="templates" onRetry={() =>
L140 Badge variant={ status === "failed" ? "destructive" : status === "ready" ? "success" : status === "building" ? "warning" : "outline" } >
L193 Button size="sm" variant="outline" disabled={busy} onClick={async () =>
L217 Button size="sm" variant="default" disabled={job?.status === "running"} onClick={() =>
L233 Button asChild size="sm">
L234 Link href="/app/getting-started">
L246 QueryError error={jobs.error} what="build progress" onRetry={() =>
L285 Dialog open={selected !== null} onOpenChange={(open) =>
L291 DialogContent className="max-h-[90vh] overflow-auto">
L296 form id="template-build-form" className="space-y-4" onSubmit={async (event) =>
L337 label htmlFor="template-list-choice-1" className="block text-sm" >
L356 label htmlFor="tpl-isoUrl" className="block text-sm">
L358 Input id="tpl-isoUrl" name="isoUrl" type="url" placeholder="https://…/windows.iso" />
L365 label htmlFor="tpl-iso" className="block text-sm">
L367 Input id="tpl-iso" name="iso" placeholder="local:iso/windows.iso" />
L373 label htmlFor="tpl-isoSha256" className="block text-sm">
L375 Input id="tpl-isoSha256" name="isoSha256" pattern="[a-fA-F0-9]{64}" />
L381 label htmlFor="tpl-virtioUrl" className="block text-sm">
L383 Input id="tpl-virtioUrl" name="virtioUrl" defaultValue="https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso" />
L389 label htmlFor="tpl-virtioSha256" className="block text-sm">
L391 Input id="tpl-virtioSha256" name="virtioSha256" pattern="[a-fA-F0-9]{64}" />
L397 label htmlFor="template-list-choice-2" className="flex gap-2 text-sm" >
L410 Button type="button" variant="outline" disabled={busy} onClick={async () =>
L456 label htmlFor="template-list-choice-3" className="flex gap-2 text-sm" >
L463 Button type="submit" disabled={busy}>
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


.sandbox-detail-heading

.sandbox-title


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


	.dashboard-sidebar-footer

	.dashboard-theme

	.dashboard-content

	.sandbox-facts

@media (max-width: 639px)

	.dashboard-content

	.sandbox-facts


	.sandbox-workspace


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


[data-testid="sandbox-state"]

.sandbox-card

.sandbox-card .sandbox-row-actions

.sandbox-title > :where(div)

.key-form fieldset

.key-form label > span

.key-preset:has(input:checked) .key-preset-title

.key-intro

.key-intro h2

.environments-page > p

.environment-summary


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

	[data-slot="page-header"] > h1

	[data-slot="page-header"] > [data-testid="quota-line"]

	.sandbox-filters > [data-slot="input"]

	.create-dialog


/* Getting started uses the dashboard palette in both appearance modes. */
.guide-layout

.guide-toc

.onboarding-checklist

.onboarding-checklist li

.onboarding-number

.onboarding-checklist a

.onboarding-checklist a:hover

@media (max-width: 900px)

	.guide-layout

	.guide-toc

	.onboarding-checklist
```
