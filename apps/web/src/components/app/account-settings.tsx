"use client";
import { SbxError } from "@sbx/sdk";
// /app/account (S8 §9.9): profile (read-only, from the IdP), default team
// (server action), SSH keys (GET/POST/DELETE /v1/ssh-keys through the SDK)
// and sign-out.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { setDefaultTeam } from "@/actions/account";
import { ConfirmButton } from "@/components/app/confirm-button";
import { useAppSession } from "@/components/app/session-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useSbx } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { formatTime } from "@/lib/format";

function Section({
	title,
	description,
	children,
	plain = false,
}: {
	plain?: boolean;
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className={plain ? "space-y-3" : "dashboard-card space-y-3"}>
			<div>
				<h2 className="text-base font-semibold">{title}</h2>
				{description && (
					<p className="text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{children}
		</section>
	);
}

export function AccountSettings({ signOutHref }: { signOutHref: string }) {
	const session = useAppSession();
	return (
		<div className="max-w-4xl space-y-8">
			<h1 className="text-xl font-semibold">Account</h1>
			<section className="dashboard-card space-y-5">
				<div className="flex items-center justify-between gap-3">
					<h2>Account · {session.user.name}</h2>
					<Button asChild variant="ghost">
						<a
							href={signOutHref}
							title="Ends the single sign-on session too; the CLI will ask for sbx login again."
						>
							Sign out
						</a>
					</Button>
				</div>
				<Profile />
				<DefaultTeam />
			</section>
			<SshKeys />
		</div>
	);
}

function Profile() {
	const s = useAppSession();
	return (
		<Section
			plain
			title="Profile"
			description="From your identity provider; change it there."
		>
			<dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-y-1 text-sm">
				<dt className="text-muted-foreground">Name</dt>
				<dd>{s.user.name}</dd>
				<dt className="text-muted-foreground">Email</dt>
				<dd>{s.user.email}</dd>
				<dt className="text-muted-foreground">User id</dt>
				<dd>
					<code>{s.user.id}</code>
				</dd>
				{s.isOperator && (
					<>
						<dt className="text-muted-foreground">Role</dt>
						<dd>
							<Badge variant="secondary">platform operator</Badge>
						</dd>
					</>
				)}
			</dl>
		</Section>
	);
}

function DefaultTeam() {
	const s = useAppSession();
	const router = useRouter();
	const [pending, start] = useTransition();
	if (s.teams.length === 0) return null;
	return (
		<Section
			plain
			title="Default team"
			description={
				<>
					Used by the CLI, SDK and API when no team is given (
					<code>Sbx-Team</code>) and when you open the dashboard.
				</>
			}
		>
			<Select
				value={s.defaultTeamId}
				disabled={pending}
				onValueChange={(teamId) =>
					start(async () => {
						const r = await attempt(() => setDefaultTeam(teamId));
						if (r === undefined) return;
						if ("error" in r) toast.error(r.error.message);
						else {
							toast.success("Default team changed");
							router.refresh();
						}
					})
				}
			>
				<SelectTrigger className="w-72" aria-label="Default team">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{s.teams.map((t) => (
						<SelectItem key={t.id} value={t.id}>
							{t.name}
							{t.personal ? " (personal)" : ""}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Section>
	);
}

/** The text of an SSH key error (S8 §9.9: in_use and type as text). */
function sshKeyError(e: unknown): string {
	if (e instanceof SbxError) {
		if (e.code === "ssh_key_in_use") {
			return "This key is already registered on the platform, on your account or someone else's. Use another key.";
		}
		if (e.code === "validation") {
			return `${e.message}. Supported: ssh-ed25519, ecdsa-sha2-nistp256/384/521, ssh-rsa of at least 3072 bits; no certificates.`;
		}
		return e.message;
	}
	return e instanceof Error ? e.message : String(e);
}

function SshKeys() {
	const s = useAppSession();
	// SSH keys belong to the person, not a team.
	const sbx = useSbx(s.defaultTeamId);
	const queryClient = useQueryClient();
	const keys = useQuery({
		queryKey: ["ssh-keys"],
		queryFn: async () => {
			const { data } = await sbx.raw.GET("/v1/ssh-keys");
			return data.data;
		},
	});
	const [name, setName] = useState("");
	const [publicKey, setPublicKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const add = useMutation({
		mutationFn: async () => {
			const { data } = await sbx.raw.POST("/v1/ssh-keys", {
				body: { name: name.trim(), publicKey: publicKey.trim() },
			});
			return data;
		},
		onSuccess: async (k) => {
			setName("");
			setPublicKey("");
			setError(null);
			toast.success(`Added ${k.name}`);
			await queryClient.invalidateQueries({ queryKey: ["ssh-keys"] });
		},
		onError: (e) => setError(sshKeyError(e)),
	});
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		add.mutate();
	};
	const remove = async (id: string): Promise<boolean> => {
		try {
			await sbx.raw.DELETE("/v1/ssh-keys/{key}", {
				params: { path: { key: id } },
			});
			await queryClient.invalidateQueries({ queryKey: ["ssh-keys"] });
			return true;
		} catch (e) {
			toast.error(sshKeyError(e));
			return false;
		}
	};

	return (
		<Section
			title="SSH keys"
			description={
				<>
					For <code>ssh &lt;sandbox&gt;@&lt;ssh host&gt;</code> into sandboxes
					of your teams.
				</>
			}
		>
			{keys.isPending && (
				<p className="text-sm text-muted-foreground">Loading…</p>
			)}
			{keys.isError && (
				<p className="text-sm text-destructive">
					Could not load SSH keys: {sshKeyError(keys.error)}
				</p>
			)}
			{keys.data && keys.data.length === 0 && (
				<p className="text-sm text-muted-foreground">No SSH keys yet.</p>
			)}
			{keys.data && keys.data.length > 0 && (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Type</TableHead>
							<TableHead>Fingerprint</TableHead>
							<TableHead>Added</TableHead>
							<TableHead>Last used</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{keys.data.map((k) => (
							<TableRow key={k.id}>
								<TableCell>{k.name}</TableCell>
								<TableCell>{k.type}</TableCell>
								<TableCell>
									<code className="text-xs">{k.fingerprint}</code>
								</TableCell>
								<TableCell>{formatTime(k.createdAt)}</TableCell>
								<TableCell>{formatTime(k.lastUsedAt)}</TableCell>
								<TableCell className="text-right">
									<ConfirmButton
										title={`Delete ${k.name}?`}
										description="The key stops working for new SSH logins at once; open sessions stay."
										confirmLabel="Delete"
										variant="ghost"
										onConfirm={() => remove(k.id)}
									>
										Delete
									</ConfirmButton>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
			<form onSubmit={submit} className="max-w-2xl space-y-2">
				<Input
					aria-label="Key name"
					placeholder="Name, e.g. laptop"
					required
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<textarea
					aria-label="Public key"
					placeholder="ssh-ed25519 AAAA… me@laptop"
					required
					rows={3}
					spellCheck={false}
					className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
					value={publicKey}
					onChange={(e) => setPublicKey(e.target.value)}
				/>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<Button
					type="submit"
					disabled={
						add.isPending || name.trim() === "" || publicKey.trim() === ""
					}
				>
					Add key
				</Button>
			</form>
		</Section>
	);
}
