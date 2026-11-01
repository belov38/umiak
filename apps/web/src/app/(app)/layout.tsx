// Root layout of the dashboard (/app); the admin has its own (app/(payload)).
import "../globals.css";
import type { Metadata } from "next";
import type React from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
	title: "sbx",
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
				<script>{`(()=>{let saved;try{saved=localStorage.getItem("sbx-theme")}catch{}document.documentElement.classList.toggle("dark",saved?saved==="dark":matchMedia("(prefers-color-scheme: dark)").matches)})()`}</script>
			</head>
			<body className="min-h-screen antialiased">
				<TooltipProvider>{children}</TooltipProvider>
				<Toaster />
			</body>
		</html>
	);
}
