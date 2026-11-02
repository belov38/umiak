// Root layout of the dashboard (/app); the admin has its own (app/(payload)).
import "../globals.css";
import type { Metadata } from "next";
import type React from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APPEARANCE_BOOTSTRAP } from "@/lib/appearance";

export const metadata: Metadata = {
	title: "Umiak",
	robots: { index: false, follow: false },
};

export default function AppRootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* Static bootstrap runs before paint; it contains no user input. */}
				<script>{APPEARANCE_BOOTSTRAP}</script>
			</head>
			<body className="min-h-screen antialiased">
				<TooltipProvider>{children}</TooltipProvider>
				<Toaster />
			</body>
		</html>
	);
}
