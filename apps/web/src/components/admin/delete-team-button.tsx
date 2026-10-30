"use client";
// The button of DeleteTeamControl: asks the api (as the operator, with
// Sbx-Team of the team) whether sandboxes, saved snapshots or environments
// are left and refuses with what is left; otherwise confirms and deletes
// the team through Payload REST, then goes back to the teams list.
import { Button, ConfirmationModal, toast, useModal } from "@payloadcms/ui";
import { useState } from "react";
import { deleteTeam, refusalText, teamContents } from "@/lib/team-delete";

const MODAL = "sbx-delete-team";

function message(e: unknown): string {
	return e instanceof Error && e.message !== "" ? e.message : "Unknown error";
}

export function DeleteTeamButton({
	uuid,
	teamId,
	name,
}: {
	uuid: string;
	teamId: string;
	name: string;
}) {
	const { openModal } = useModal();
	const [busy, setBusy] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);

	const check = async () => {
		setBusy(true);
		setRefusal(null);
		try {
			const why = refusalText(await teamContents(fetch, teamId));
			if (why === null) openModal(MODAL);
			else setRefusal(why);
		} catch (e) {
			setRefusal(`Could not check the team in the api: ${message(e)}`);
		} finally {
			setBusy(false);
		}
	};

	const confirm = async () => {
		try {
			await deleteTeam(fetch, uuid);
		} catch (e) {
			toast.error(`The team was not deleted: ${message(e)}`);
			return;
		}
		toast.success(`Team ${name} deleted`);
		window.location.assign("/admin/collections/teams");
	};

	return (
		<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
			{refusal !== null && (
				<span
					role="alert"
					data-testid="delete-team-refusal"
					style={{
						color: "var(--theme-error-500)",
						fontSize: "13px",
						maxWidth: "28rem",
					}}
				>
					{refusal}
				</span>
			)}
			<Button
				buttonStyle="secondary"
				size="medium"
				margin={false}
				disabled={busy}
				onClick={check}
				id="sbx-delete-team"
			>
				{busy ? "Checking…" : "Delete team"}
			</Button>
			<ConfirmationModal
				modalSlug={MODAL}
				heading={`Delete team ${name}?`}
				body="It has no sandboxes, saved snapshots or environments. Its memberships and notices are deleted and its API keys revoked. This cannot be undone."
				confirmLabel="Delete team"
				confirmingLabel="Deleting…"
				onConfirm={confirm}
			/>
		</div>
	);
}
