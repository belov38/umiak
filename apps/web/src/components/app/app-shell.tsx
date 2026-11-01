"use client";
// The common frame of /app (S8 §9.3):
// umiak  [Team: <name> v]  Sandboxes Snapshots Environments Keys Team
//                                 [Operator] [Admin]   <email> (v)
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type React from "react";
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

const NAV: { label: string; section?: string }[] = [
	{ label: "Sandboxes" },
	{ label: "Snapshots", section: "snapshots" },
	{ label: "Environments", section: "environments" },
	{ label: "Keys", section: "keys" },
	{ label: "Team", section: "settings" },
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
		<div className="min-h-screen">
			<header className="border-b">
				<div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
					<Link href="/app" className="font-semibold tracking-tight">
						umiak
					</Link>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm" data-testid="team-switcher">
								<span className="text-muted-foreground">Team:</span>
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
					<nav className="flex items-center gap-1">
						{NAV.map((n) => (
							<Button
								key={n.label}
								asChild
								variant={active(n.section) ? "secondary" : "ghost"}
								size="sm"
							>
								<Link href={teamPath(team.id, n.section)}>{n.label}</Link>
							</Button>
						))}
					</nav>
					<div className="ml-auto flex items-center gap-1">
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
										will ask for `umiak login` again.
									</TooltipContent>
								</Tooltip>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</header>
			<main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
		</div>
	);
}
