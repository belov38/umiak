"use client";
// Customer dashboard frame; team routes and authorization stay unchanged.
import {
	ArchiveIcon,
	BookOpenIcon,
	BoxIcon,
	CheckIcon,
	ChevronDownIcon,
	KeyRoundIcon,
	LayersIcon,
	MenuIcon,
	MoonIcon,
	SettingsIcon,
	ShieldIcon,
	SlidersHorizontalIcon,
	SunIcon,
	UserIcon,
	WrenchIcon,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { PlatformUpdateBanner } from "@/components/app/platform-updates";
import {
	useAppSession,
	useSingleOwner,
} from "@/components/app/session-context";
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
import Link from "@/components/ui/link";
import { NavItem } from "@/components/ui/nav-item";
import type { AppTeam } from "@/lib/app-session";
import { usePathname } from "@/lib/navigation";
import { switchTeamPath, teamPath } from "@/lib/team-path";
import { cn } from "@/lib/utils";
import { OwnerModeContext } from "./session-context";

const NAV = [
	{ label: "Sandboxes", section: undefined, icon: BoxIcon },
	{ label: "Snapshots", section: "snapshots", icon: ArchiveIcon },
	{ label: "Environment", section: "environments", icon: LayersIcon },
	{ label: "API keys", section: "keys", icon: KeyRoundIcon },
];

export function AppShell({
	team,
	member,
	ownerMode = false,
	quickstart = false,
	children,
}: {
	team: AppTeam;
	/** False when an operator looks at a team they are not in. */
	member: boolean;
	ownerMode?: boolean;
	quickstart?: boolean;
	children: React.ReactNode;
}) {
	const session = useAppSession();
	const singleOwner = useSingleOwner();
	const pathname = usePathname();
	const [mobileOpen, setMobileOpen] = useState(false);
	const [dark, setDark] = useState<boolean | null>(null);
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
			return (
				(singleOwner && pathname === "/app") ||
				pathname === base ||
				pathname.startsWith(`${base}/sandboxes`)
			);
		}
		const p = teamPath(team.id, section);
		return pathname === p || pathname.startsWith(`${p}/`);
	};

	const switcher = singleOwner ? null : (
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
			<nav
				className="dashboard-nav"
				aria-label={singleOwner ? "Navigation" : "Team navigation"}
			>
				{NAV.map((n) => (
					<NavItem
						key={n.label}
						asChild
						variant={active(n.section) ? "secondary" : "ghost"}
						size="sm"
					>
						<Link
							href={
								singleOwner && n.section === undefined
									? "/app"
									: teamPath(team.id, n.section)
							}
							onClick={() => setMobileOpen(false)}
							aria-current={active(n.section) ? "page" : undefined}
						>
							<n.icon />
							{n.label}
						</Link>
					</NavItem>
				))}

				<NavItem
					asChild
					variant={pathname === "/app/templates" ? "secondary" : "ghost"}
					size="sm"
				>
					<Link
						href="/app/templates"
						onClick={() => setMobileOpen(false)}
						aria-current={pathname === "/app/templates" ? "page" : undefined}
					>
						<LayersIcon />
						Templates
					</Link>
				</NavItem>

				<NavItem
					asChild
					variant={pathname === "/app/getting-started" ? "secondary" : "ghost"}
					size="sm"
				>
					<Link
						href="/app/getting-started"
						onClick={() => setMobileOpen(false)}
						aria-current={
							pathname === "/app/getting-started" ? "page" : undefined
						}
					>
						<BookOpenIcon />
						Getting started
					</Link>
				</NavItem>
				{singleOwner ? (
					<NavItem
						asChild
						variant={pathname === "/app/settings" ? "secondary" : "ghost"}
						size="sm"
					>
						<Link
							href="/app/settings"
							onClick={() => setMobileOpen(false)}
							aria-current={pathname === "/app/settings" ? "page" : undefined}
						>
							<SettingsIcon />
							Settings
						</Link>
					</NavItem>
				) : (
					<>
						<NavItem
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
						</NavItem>
						<NavItem
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
						</NavItem>
					</>
				)}
			</nav>
			<div className="dashboard-sidebar-footer">
				{quickstart && (
					<>
						<NavItem asChild variant="ghost" size="sm">
							<a href="/setup">
								<WrenchIcon />
								Setup
							</a>
						</NavItem>
						<NavItem asChild variant="ghost" size="sm">
							<a href="/owner/sessions">
								<UserIcon />
								Owner sessions
							</a>
						</NavItem>
					</>
				)}
				{session.isOperator && !singleOwner && (
					<>
						<NavItem
							asChild
							variant={pathname === "/app/operator" ? "secondary" : "ghost"}
							size="sm"
						>
							<Link
								href="/app/operator"
								aria-current={pathname === "/app/operator" ? "page" : undefined}
							>
								<ShieldIcon />
								Operator
							</Link>
						</NavItem>
						<NavItem asChild variant="ghost" size="sm">
							{/* The admin is another root layout: a full page load. */}
							<a href="/admin">
								<SlidersHorizontalIcon />
								Admin
							</a>
						</NavItem>
					</>
				)}
				{!singleOwner && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<NavItem variant="ghost" size="sm" data-testid="user-menu">
								<span className="max-w-56 truncate">{session.user.email}</span>
								<ChevronDownIcon />
							</NavItem>
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
						</DropdownMenuContent>
					</DropdownMenu>
				)}
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
					<OwnerModeContext.Provider value={ownerMode}>
						{quickstart && <PlatformUpdateBanner />}
						{children}
					</OwnerModeContext.Provider>
				</div>
			</main>
		</div>
	);
}

function ThemeSwitch({
	dark,
	onChange,
}: {
	dark: boolean | null;
	onChange: (next: boolean) => void;
}) {
	return (
		<fieldset
			className="dashboard-theme"
			aria-label="Appearance"
			style={{ visibility: dark === null ? "hidden" : "visible" }}
		>
			<NavItem
				variant={!dark ? "secondary" : "ghost"}
				size="theme"
				aria-pressed={!dark}
				onClick={() => onChange(false)}
			>
				<SunIcon />
				Light
			</NavItem>
			<NavItem
				variant={dark ? "secondary" : "ghost"}
				size="theme-end"
				aria-pressed={dark === true}
				onClick={() => onChange(true)}
			>
				<MoonIcon />
				Dark
			</NavItem>
		</fieldset>
	);
}
