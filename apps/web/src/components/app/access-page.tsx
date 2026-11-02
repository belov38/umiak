"use client";

import { type ReactNode, useLayoutEffect } from "react";
import { ACCESS_CSS } from "@/lib/access-style";
import { APPEARANCE_BOOTSTRAP } from "@/lib/appearance";
import { UmiakLogo } from "./umiak-logo";

export function AccessPage({ children }: { children: ReactNode }) {
	// Next auth interrupts can replace the root document and insert this
	// boundary through React, where an inline script is not executed.
	useLayoutEffect(() => {
		let saved: string | null = null;
		try {
			saved = localStorage.getItem("umiak-theme");
		} catch {}
		document.documentElement.classList.toggle(
			"dark",
			saved
				? saved === "dark"
				: matchMedia("(prefers-color-scheme: dark)").matches,
		);
	}, []);
	return (
		<>
			<style>{ACCESS_CSS}</style>
			<script>{APPEARANCE_BOOTSTRAP}</script>
			<main className="umiak-access">
				<a href="/app" aria-label="Umiak">
					<UmiakLogo />
				</a>
				{children}
			</main>
		</>
	);
}
