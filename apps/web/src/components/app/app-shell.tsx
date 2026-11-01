"use client";
// Customer dashboard frame; team routes and authorization stay unchanged.
import {
	ArchiveIcon,
	BoxIcon,
	CheckIcon,
	ChevronDownIcon,
	KeyRoundIcon,
	LayersIcon,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const NAV = [
	{ label: "Sandboxes", section: undefined, icon: BoxIcon },
	{ label: "Snapshots", section: "snapshots", icon: ArchiveIcon },
	{ label: "Environment", section: "environments", icon: LayersIcon },
	{ label: "API keys", section: "keys", icon: KeyRoundIcon },
	{ label: "Team", section: "settings", icon: SettingsIcon },
];

export function AppShell({
	team,
	member,
	logoutUrl,
	children,
}: {
	team: AppTeam;
	/** False when an operator looks at a team they are not in. */
	member: boolean;
	logoutUrl: string | null;
	children: React.ReactNode;
}) {
	const session = useAppSession();
	const pathname = usePathname();
	const base = teamPath(team.id);
	const active = (section?: string) => {
		if (section === undefined) {
			return pathname === base || pathname.startsWith(`${base}/sandboxes`);
		}
		const p = teamPath(team.id, section);
		return pathname === p || pathname.startsWith(`${p}/`);
	};

	return (
		<div className="dashboard-shell">
			<aside className="dashboard-sidebar" aria-label="Dashboard">
				<a href="#dashboard-content" className="dashboard-skip">
					Skip to content
				</a>
				<div className="dashboard-sidebar-content">
					<Link href="/app" className="dashboard-brand">
						sbx
					</Link>
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
										<CheckIcon
											className={cn(t.id === team.id ? "" : "invisible")}
										/>
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
								aria-current={pathname === "/app/account" ? "page" : undefined}
							>
								<UserIcon />
								Account
							</Link>
						</Button>
					</nav>
					<div className="dashboard-sidebar-footer">
						{session.isOperator && (
							<>
								<Button asChild variant="ghost" size="sm">
									<Link href="/app/operator">Operator</Link>
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
									<span className="max-w-56 truncate">
										{session.user.email}
									</span>
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
								<Tooltip>
									<TooltipTrigger asChild>
										<DropdownMenuItem asChild>
											{/* oauth2-proxy route: a full page load. */}
											<a href={signOutHref(logoutUrl)}>Sign out</a>
										</DropdownMenuItem>
									</TooltipTrigger>
									<TooltipContent side="left" className="max-w-64">
										Signs you out of the single sign-on session too: the CLI
										will ask for `sbx login` again.
									</TooltipContent>
								</Tooltip>
							</DropdownMenuContent>
						</DropdownMenu>
						<ThemeSwitch />
					</div>
				</div>
			</aside>
			<main id="dashboard-content" className="dashboard-content">
				{children}
			</main>
		</div>
	);
}

function ThemeSwitch() {
	const [dark, setDark] = useState(false);
	useEffect(() => {
		const saved = localStorage.getItem("sbx-theme");
		const next = saved
			? saved === "dark"
			: matchMedia("(prefers-color-scheme: dark)").matches;
		setDark(next);
		document.documentElement.classList.toggle("dark", next);
	}, []);
	const choose = (next: boolean) => {
		setDark(next);
		document.documentElement.classList.toggle("dark", next);
		localStorage.setItem("sbx-theme", next ? "dark" : "light");
	};
	return (
		<fieldset className="dashboard-theme" aria-label="Appearance">
			<Button
				variant={!dark ? "secondary" : "ghost"}
				aria-pressed={!dark}
				onClick={() => choose(false)}
			>
				<SunIcon />
				Light
			</Button>
			<Button
				variant={dark ? "secondary" : "ghost"}
				aria-pressed={dark}
				onClick={() => choose(true)}
			>
				<MoonIcon />
				Dark
			</Button>
		</fieldset>
	);
}
