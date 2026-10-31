// Saved snapshots of the team (S8 §9.7).
import { SnapshotList } from "@/features/snapshots/snapshot-list";

export default async function SnapshotsPage({
	params,
}: {
	params: Promise<{ team: string }>;
}) {
	const { team } = await params;
	return <SnapshotList teamId={team} />;
}
