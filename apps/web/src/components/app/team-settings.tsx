"use client";
// /app/t/<team>/settings (S8 §9.9): name, members, invite, leave, quota and
// usage. Team data comes from the server page, changes go through server
// actions; quota and usage come from GET /v1/limits through the SDK.
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	inviteMember,
	leaveTeam,
	removeMember,
	setRole,
} from "@/actions/members";
import { renameTeam } from "@/actions/teams";
import { ConfirmButton } from "@/components/app/confirm-button";
import { ConnectionNotice } from "@/components/app/connection-notice";
import { QueryError } from "@/components/app/query-error";
import { useAppSession } from "@/components/app/session-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { PageHeader, Panel } from "@/components/ui/panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useUmiak } from "@/lib/api";
import { useAttempt } from "@/lib/client-call";
import { formatMb, formatTime } from "@/lib/format";
import { can, type TeamRole } from "@/lib/permissions";
import type { ActionResult } from "@/lib/team-actions/core";
import type {
	TeamMemberView,
	TeamSettingsData,
} from "@/lib/team-actions/team-settings";

/**
 * Shows the error of a server action; true on success. `undefined`: the
 * call itself threw and `attempt` has already shown a toast.
 */
function done(r: ActionResult<object> | undefined, success?: string): boolean {
	if (r === undefined) return false;
	if ("error" in r) {
		toast.error(r.error.message);
		return false;
	}
	if (success) toast.success(success);
	return true;
}

export function TeamSettings({ data }: { data: TeamSettingsData }) {
	const session = useAppSession();
	const perm = { role: data.myRole, personal: data.team.personal };
	return (
		<div className="space-y-6">
			<PageHeader title="Team settings" />
			<ConnectionNotice />
			<NameSection data={data} canRename={can(session, perm, "renameTeam")} />
			<QuotaSection teamId={data.team.id} />
			<MembersSection
				data={data}
				canManage={can(session, perm, "manageMembers")}
				canInvite={can(session, perm, "inviteMember")}
				me={session.user.id}
			/>
			{can(session, perm, "leaveTeam") && <LeaveSection data={data} />}
		</div>
	);
}

function Section({
	title,
	children,
	description,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Panel className="space-y-3">
			<div>
				<h2 className="text-base font-semibold">{title}</h2>
				{description && (
					<p className="text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{children}
		</Panel>
	);
}

function NameSection({
	data,
	canRename,
}: {
	data: TeamSettingsData;
	canRename: boolean;
}) {
	const attempt = useAttempt();
	const router = useRouter();
	const [name, setName] = useState(data.team.name);
	const [pending, start] = useTransition();
	const submit = (e: FormEvent) => {
		e.preventDefault();
		start(async () => {
			const r = await attempt(() => renameTeam(data.team.id, name));
			if (done(r, "Team renamed")) {
				router.refresh();
			}
		});
	};
	return (
		<Panel className="space-y-3">
			<div className="flex items-center gap-2">
				<h2>Team name</h2>
				{data.team.personal && <Badge variant="secondary">personal</Badge>}
			</div>
			{canRename ? (
				<form onSubmit={submit} className="flex max-w-md gap-2 pt-2">
					<Input
						aria-label="Team name"
						value={name}
						maxLength={64}
						onChange={(e) => setName(e.target.value)}
					/>
					<Button
						type="submit"
						disabled={
							pending || name.trim() === "" || name.trim() === data.team.name
						}
					>
						Rename
					</Button>
				</form>
			) : (
				<p className="text-muted-foreground">{data.team.name}</p>
			)}
		</Panel>
	);
}

export function QuotaSection({ teamId }: { teamId: string }) {
	const umiak = useUmiak(teamId);
	const limits = useQuery({
		queryKey: ["limits", teamId],
		queryFn: () => umiak.limits(),
	});
	const rows = limits.data
		? [
				{
					label: "Active sandboxes",
					used: String(limits.data.usage.activeSandboxes),
					quota: String(limits.data.quota.maxActiveSandboxes),
				},
				{
					label: "RAM",
					used: formatMb(limits.data.usage.ramMb),
					quota: formatMb(limits.data.quota.maxRamMb),
				},
				{
					label: "Saved snapshots",
					used: String(limits.data.usage.savedSnapshots),
					quota: String(limits.data.quota.maxSavedSnapshots),
				},
			]
		: [];
	return (
		<Section title="Quota and usage" description="Set by a platform operator.">
			{limits.isPending && <LoadingState />}
			{limits.isError && (
				<QueryError error={limits.error} what="limits and usage" />
			)}
			{limits.data && (
				<Table className="max-w-md">
					<TableHeader>
						<TableRow>
							<TableHead />
							<TableHead>Used</TableHead>
							<TableHead>Quota</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((r) => (
							<TableRow key={r.label}>
								<TableCell>{r.label}</TableCell>
								<TableCell>{r.used}</TableCell>
								<TableCell>{r.quota}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</Section>
	);
}

function MembersSection({
	data,
	canManage,
	canInvite,
	me,
}: {
	data: TeamSettingsData;
	canManage: boolean;
	canInvite: boolean;
	me: string;
}) {
	return (
		<Section title="Members">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Email</TableHead>
						<TableHead>Name</TableHead>
						<TableHead>Role</TableHead>
						<TableHead>Last sign-in</TableHead>
						{canManage && <TableHead />}
					</TableRow>
				</TableHeader>
				<TableBody>
					{data.members.map((m) => (
						<MemberRow
							key={m.id}
							member={m}
							canManage={canManage}
							isMe={m.userId === me}
						/>
					))}
				</TableBody>
			</Table>
			{canInvite && <InviteForm teamId={data.team.id} />}
			{data.team.personal && (
				<p className="text-sm text-muted-foreground">
					A personal team has no other members.{" "}
					<Link href="/app/teams/new" className="underline">
						Create a shared team
					</Link>{" "}
					to work together.
				</p>
			)}
		</Section>
	);
}

function MemberRow({
	member,
	canManage,
	isMe,
}: {
	member: TeamMemberView;
	canManage: boolean;
	isMe: boolean;
}) {
	const attempt = useAttempt();
	const router = useRouter();
	const [pending, start] = useTransition();
	const changeRole = (role: TeamRole) =>
		start(async () => {
			if (done(await attempt(() => setRole(member.id, role)), "Role changed")) {
				router.refresh();
			}
		});
	return (
		<TableRow data-testid="member-row">
			<TableCell>
				{member.email}
				{isMe && <span className="ml-1 text-muted-foreground">(you)</span>}
				{!member.active && (
					<Badge variant="secondary" className="ml-2">
						deactivated
					</Badge>
				)}
			</TableCell>
			<TableCell>{member.name ?? "—"}</TableCell>
			<TableCell>
				{canManage ? (
					<Select
						value={member.role}
						disabled={pending}
						onValueChange={(v) => changeRole(v as TeamRole)}
					>
						<SelectTrigger size="sm" aria-label={`Role of ${member.email}`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="owner">owner</SelectItem>
							<SelectItem value="member">member</SelectItem>
						</SelectContent>
					</Select>
				) : (
					member.role
				)}
			</TableCell>
			<TableCell>
				{member.neverSignedIn ? (
					<Badge variant="outline">Not signed in yet</Badge>
				) : (
					formatTime(member.lastLoginAt)
				)}
			</TableCell>
			{canManage && (
				<TableCell className="text-right">
					<ConfirmButton
						title={`Remove ${member.email}?`}
						description="Their sandboxes and the team keys they created stay with the team. Their open terminals and SSH sessions in this team are closed."
						confirmLabel="Remove"
						variant="ghost"
						onConfirm={async () => {
							const ok = done(
								await attempt(() => removeMember(member.id)),
								"Member removed",
							);
							if (ok) router.refresh();
							return ok;
						}}
					>
						Remove
					</ConfirmButton>
				</TableCell>
			)}
		</TableRow>
	);
}

function InviteForm({ teamId }: { teamId: string }) {
	const attempt = useAttempt();
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [role, setRoleValue] = useState<TeamRole>("member");
	const [pending, start] = useTransition();
	const submit = (e: FormEvent) => {
		e.preventDefault();
		start(async () => {
			const r = await attempt(() => inviteMember(teamId, email, role));
			if (
				done(
					r,
					r !== undefined && "ok" in r && r.stub
						? `${email.trim()} is invited; they join at their first sign-in.`
						: "Member added",
				)
			) {
				setEmail("");
				router.refresh();
			}
		});
	};
	return (
		<form onSubmit={submit} className="flex max-w-xl flex-wrap gap-2">
			<Input
				type="email"
				required
				placeholder="Email"
				aria-label="Email to invite"
				className="w-72"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<Select value={role} onValueChange={(v) => setRoleValue(v as TeamRole)}>
				<SelectTrigger aria-label="Role of the new member">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="member">member</SelectItem>
					<SelectItem value="owner">owner</SelectItem>
				</SelectContent>
			</Select>
			<Button type="submit" disabled={pending || email.trim() === ""}>
				Invite
			</Button>
			<p className="basis-full text-xs text-muted-foreground">
				No email is sent: share the dashboard link yourself. Someone who has not
				signed in yet shows as “Not signed in yet”.
			</p>
		</form>
	);
}

function LeaveSection({ data }: { data: TeamSettingsData }) {
	const attempt = useAttempt();
	const router = useRouter();
	return (
		<Section title="Leave the team">
			<ConfirmButton
				title={`Leave ${data.team.name}?`}
				description="You lose access to its sandboxes, snapshots and keys. An owner can invite you again."
				confirmLabel="Leave"
				variant="destructive"
				onConfirm={async () => {
					const ok = done(
						await attempt(() => leaveTeam(data.team.id)),
						"You left the team",
					);
					if (ok) router.push("/app");
					return ok;
				}}
			>
				Leave team
			</ConfirmButton>
		</Section>
	);
}
