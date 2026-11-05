"use client";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/app/copy-button";
import { useAppSession } from "@/components/app/session-context";
import { CodeBlock } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/panel";
import { type GuideDeployment, guideSections } from "./content";
import { FirstSandboxAction } from "./first-sandbox-action";

export function GettingStarted({
	deployment,
}: {
	deployment: GuideDeployment;
}) {
	const session = useAppSession();
	const [current, setCurrent] = useState(deployment);
	useEffect(() => {
		const controller = new AbortController();
		// Owner metadata uses the public request origin, including a trusted Serve origin.
		const endpoint = deployment.mode === "owner" ? "/v1/meta" : "/api/v1/meta";
		if (deployment.mode === "owner")
			setCurrent({
				...deployment,
				apiUrl: window.location.origin,
				appUrl: window.location.origin,
			});
		fetch(endpoint, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) return;
				const meta: unknown = await response.json();
				if (!meta || typeof meta !== "object") return;
				const value = meta as Record<string, unknown>;
				const validUrl = (v: unknown): v is string =>
					typeof v === "string" && /^https?:\/\//.test(v);
				setCurrent((previous) => ({
					...previous,
					...(validUrl(value.apiUrl) ? { apiUrl: value.apiUrl } : {}),
					...(validUrl(value.appUrl) ? { appUrl: value.appUrl } : {}),
					...(value.previewScheme === "http" || value.previewScheme === "https"
						? { previewScheme: value.previewScheme }
						: {}),
					...(typeof value.previewPort === "number" &&
					Number.isInteger(value.previewPort) &&
					value.previewPort > 0 &&
					value.previewPort <= 65535
						? { previewPort: value.previewPort }
						: {}),
					...(typeof value.umiakDomain === "string"
						? { previewDomain: value.umiakDomain }
						: {}),
				}));
			})
			.catch(() => {
				/* Environment defaults remain usable if metadata is unavailable. */
			});
		return () => controller.abort();
	}, [deployment]);
	const sections = guideSections(current);
	return (
		<article className="getting-started space-y-8">
			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">YOUR FIRST SANDBOX</p>
				<PageHeader title="Getting started" />
				<p className="max-w-3xl text-muted-foreground">
					A virtual machine for your code, tools and agents. Start in the
					dashboard or follow the CLI guide below.
				</p>
				<FirstSandboxAction teamId={session.defaultTeamId} />
				<ol className="space-y-2 text-sm">
					<li>1. Create a sandbox.</li>
					<li>
						2. Open Terminal and run <code>uname -a</code>.
					</li>
					<li>
						3. Optional: install the CLI and connect an agent using the guide
						below.
					</li>
				</ol>
				<dl className="guide-addresses grid gap-3 border bg-muted/30 p-4 text-sm sm:grid-cols-2">
					<div>
						<dt className="text-muted-foreground">Dashboard</dt>
						<dd className="break-all">{current.appUrl}</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">API</dt>
						<dd className="break-all">{current.apiUrl}</dd>
					</div>
				</dl>
			</div>
			<div className="guide-layout">
				<nav aria-label="Getting started sections" className="guide-toc">
					<p className="mb-3 text-sm font-semibold">In this guide</p>
					{sections.map((section) => (
						<a
							key={section.id}
							href={`#${section.id}`}
							className="block text-sm text-link underline underline-offset-4"
						>
							{section.title}
						</a>
					))}
				</nav>
				<div className="min-w-0 space-y-10">
					{sections.map((section) => (
						<section
							key={section.id}
							id={section.id}
							className="scroll-mt-8 space-y-4"
						>
							<h2 className="text-xl font-semibold">{section.title}</h2>
							{section.blocks.map((block) =>
								block.kind === "text" ? (
									<p
										key={block.text}
										className="leading-relaxed text-muted-foreground"
									>
										{block.text}
									</p>
								) : (
									<div
										key={block.label}
										className="overflow-hidden border bg-muted/30"
									>
										<div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
											<span className="text-xs text-muted-foreground">
												{block.label}
											</span>
											<CopyButton
												label={`Copy ${block.label}`}
												text={block.text}
											/>
										</div>
										<CodeBlock className="overflow-x-auto p-4 text-xs leading-relaxed">
											<code>{block.text}</code>
										</CodeBlock>
									</div>
								),
							)}
						</section>
					))}
				</div>
			</div>
		</article>
	);
}
