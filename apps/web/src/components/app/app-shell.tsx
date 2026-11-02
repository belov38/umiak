"use client";
// Customer dashboard frame; team routes and authorization stay unchanged.
import {
	ArchiveIcon,
	BoxIcon,
	CheckIcon,
	ChevronDownIcon,
	KeyRoundIcon,
	LayersIcon,
	MenuIcon,
	MoonIcon,
	SettingsIcon,
	SunIcon,
	UserIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type React from "react";
import { useEffect, useState } from "react";
import { useAppSession } from "@/components/app/session-context";
import { UmiakLogo } from "@/components/app/umiak-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppTeam } from "@/lib/app-session";
import { signOutHref, switchTeamPath, teamPath } from "@/lib/team-path";
import { cn } from "@/lib/utils";
import { LocalModeContext } from "./session-context";

const NAV = [
	{ label: "Sandboxes", section: undefined, icon: BoxIcon },
	{ label: "Snapshots", section: "snapshots", icon: ArchiveIcon },
	{ label: "Environment", section: "environments", icon: LayersIcon },
	{ label: "API keys", section: "keys", icon: KeyRoundIcon },
];

export function AppShell({
	team,
	member,
	logoutUrl,
	localMode = false,
	quickstart = false,
	children,
}: {
	team: AppTeam;
	/** False when an operator looks at a team they are not in. */
	member: boolean;
	logoutUrl: string | null;
	localMode?: boolean;
	quickstart?: boolean;
	children: React.ReactNode;
}) {
	const session = useAppSession();
	const pathname = usePathname();
	const [mobileOpen, setMobileOpen] = useState(false);
	const [dark, setDark] = useState(false);
	useEffect(() => {
		setDark(document.documentElement.classList.contains("dark"));
	}, []);
	const chooseTheme = (next: boolean) => {
		setDark(next);
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.setItem("umiak-theme", next ? "dark" : "light");
		} catch {
			// The in-memory preference still works if storage is unavailable.
		}
	};
	useEffect(() => {
		const wide = matchMedia("(min-width: 1024px)");
		const close = () => {
			if (wide.matches) setMobileOpen(false);
		};
		wide.addEventListener("change", close);
		return () => wide.removeEventListener("change", close);
	}, []);

	const base = teamPath(team.id);
	const active = (section?: string) => {
		if (section === undefined) {
			return pathname === base || pathname.startsWith(`${base}/sandboxes`);
		}
		const p = teamPath(team.id, section);
		return pathname === p || pathname.startsWith(`${p}/`);
	};

	const switcher = (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					className="w-full justify-between"
					data-testid="team-switcher"
				>
					<span className="sr-only">Team:</span>
					<span className="max-w-48 truncate">{team.name}</span>
					{!member && <Badge variant="secondary">operator</Badge>}
					<ChevronDownIcon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-56">
				<DropdownMenuLabel>Teams</DropdownMenuLabel>
				{session.teams.map((t) => (
					<DropdownMenuItem key={t.id} asChild>
						<Link href={switchTeamPath(pathname, t.id)}>
							<CheckIcon className={cn(t.id === team.id ? "" : "invisible")} />
							<span className="truncate">{t.name}</span>
							{t.personal && (
								<span className="ml-auto text-xs text-muted-foreground">
									personal
								</span>
							)}
						</Link>
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<Link href="/app/teams/new">Create team…</Link>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
	const sidebar = (
		<div className="dashboard-sidebar-content">
			<Link href="/app" className="dashboard-brand" aria-label="Umiak">
				<UmiakLogo />
			</Link>
			<div className="desktop-team-switcher">{switcher}</div>
			<nav className="dashboard-nav" aria-label="Team navigation">
				{NAV.map((n) => (
					<Button
						key={n.label}
						asChild
						variant={active(n.section) ? "secondary" : "ghost"}
						size="sm"
					>
						<Link
							href={teamPath(team.id, n.section)}
							onClick={() => setMobileOpen(false)}
							aria-current={active(n.section) ? "page" : undefined}
						>
							<n.icon />
							{n.label}
						</Link>
					</Button>
				))}

				<Button
					asChild
					variant={pathname === "/app/account" ? "secondary" : "ghost"}
					size="sm"
				>
					<Link
						href="/app/account"
						onClick={() => setMobileOpen(false)}
						aria-current={pathname === "/app/account" ? "page" : undefined}
					>
						<UserIcon />
						Account
					</Link>
				</Button>
				<Button
					asChild
					variant={active("settings") ? "secondary" : "ghost"}
					size="sm"
				>
					<Link
						onClick={() => setMobileOpen(false)}
						href={teamPath(team.id, "settings")}
						aria-current={active("settings") ? "page" : undefined}
					>
						<SettingsIcon />
						Team
					</Link>
				</Button>
			</nav>
			<div className="dashboard-sidebar-footer">
				{quickstart && (
					<>
						<Button asChild variant="ghost" size="sm">
							<a href="/app/help">Help</a>
						</Button>
						<Button asChild variant="ghost" size="sm">
							<a href="/setup">Setup</a>
						</Button>
					</>
				)}
				{session.isOperator && (
					<>
						<Button
							asChild
							variant={pathname === "/app/operator" ? "secondary" : "ghost"}
							size="sm"
						>
							<Link
								href="/app/operator"
								aria-current={pathname === "/app/operator" ? "page" : undefined}
							>
								Operator
							</Link>
						</Button>
						<Button asChild variant="ghost" size="sm">
							{/* The admin is another root layout: a full page load. */}
							<a href="/admin">Admin</a>
						</Button>
					</>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm" data-testid="user-menu">
							<span className="max-w-56 truncate">{session.user.email}</span>
							<ChevronDownIcon />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-56">
						<DropdownMenuLabel className="font-normal">
							<div className="font-medium">{session.user.name}</div>
							<div className="text-xs text-muted-foreground">
								{session.user.email}
							</div>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							<Link href="/app/account">Account</Link>
						</DropdownMenuItem>
						{!localMode && (
							<Tooltip>
								<TooltipTrigger asChild>
									<DropdownMenuItem asChild>
										{/* oauth2-proxy route: a full page load. */}
										<a href={signOutHref(logoutUrl)}>Sign out</a>
									</DropdownMenuItem>
								</TooltipTrigger>
								<TooltipContent side="left" className="max-w-64">
									Signs you out of the single sign-on session too: the CLI will
									ask for `umiak login` again.
								</TooltipContent>
							</Tooltip>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				<ThemeSwitch dark={dark} onChange={chooseTheme} />
			</div>
		</div>
	);
	return (
		<div className="dashboard-shell">
			<a href="#dashboard-content" className="dashboard-skip">
				Skip to content
			</a>
			<header className="dashboard-mobile-header">
				<Link href="/app" className="dashboard-brand" aria-label="Umiak">
					<UmiakLogo />
				</Link>
				<div className="mobile-team-switcher">{switcher}</div>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Open navigation"
					aria-expanded={mobileOpen}
					aria-controls="dashboard-mobile-navigation"
					onClick={() => setMobileOpen(!mobileOpen)}
				>
					<MenuIcon />
				</Button>
			</header>
			<aside
				id="dashboard-navigation"
				className="dashboard-sidebar"
				data-open={mobileOpen}
				aria-label="Dashboard"
			>
				{sidebar}
			</aside>
			<Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
				<DialogContent
					className="dashboard-drawer"
					placement="left"
					id="dashboard-mobile-navigation"
				>
					<DialogTitle className="sr-only">Dashboard navigation</DialogTitle>
					{sidebar}
				</DialogContent>
			</Dialog>
			<main id="dashboard-content" className="dashboard-content" tabIndex={-1}>
				<div className="dashboard-page">
					<LocalModeContext.Provider value={localMode}>
						{children}
					</LocalModeContext.Provider>
				</div>
			</main>
		</div>
	);
}

function ThemeSwitch({
	dark,
	onChange,
}: {
	dark: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<fieldset className="dashboard-theme" aria-label="Appearance">
			<Button
				variant={!dark ? "secondary" : "ghost"}
				aria-pressed={!dark}
				onClick={() => onChange(false)}
			>
				<SunIcon />
				Light
			</Button>
			<Button
				variant={dark ? "secondary" : "ghost"}
				aria-pressed={dark}
				onClick={() => onChange(true)}
			>
				<MoonIcon />
				Dark
			</Button>
		</fieldset>
	);
}
