// Root layout of the dashboard (/app); the admin has its own (app/(payload)).
import "../globals.css";
import type { Metadata } from "next";
import type React from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

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
		<html lang="en">
			<body className="min-h-screen antialiased">
				<TooltipProvider>{children}</TooltipProvider>
				<Toaster />
			</body>
		</html>
	);
}
