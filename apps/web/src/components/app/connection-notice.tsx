"use client";
import { useEffect, useState } from "react";
import {
	certificateExpiryLines,
	tailnetExposureWarning,
} from "@/lib/browser-guidance";

export function ConnectionNotice() {
	const [warning, setWarning] = useState<string | null>(null);
	const [certificates, setCertificates] = useState<string[]>([]);
	useEffect(() => {
		setWarning(tailnetExposureWarning(window.location.hostname));
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
			{warning && <p role="status">{warning}</p>}
			{certificates.map((line) => (
				<p key={line} role="status">
					{line}
				</p>
			))}
		</>
	);
}
