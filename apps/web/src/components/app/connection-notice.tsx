"use client";
import { useEffect, useState } from "react";
import { certificateExpiryLines } from "@/lib/browser-guidance";

export function ConnectionNotice() {
	const [certificates, setCertificates] = useState<string[]>([]);
	useEffect(() => {
		const controller = new AbortController();
		fetch("/quickstart/setup/certificates", { signal: controller.signal })
			.then(async (response) => {
				if (response.ok)
					setCertificates(certificateExpiryLines(await response.json()));
			})
			.catch(() => {});
		return () => controller.abort();
	}, []);
	return (
		<>
			{certificates.map((line) => (
				<p key={line} role="status">
					{line}
				</p>
			))}
		</>
	);
}
