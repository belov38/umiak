"use client";
import { SshKeys } from "@/components/app/account-settings";
import { ConnectionNotice } from "@/components/app/connection-notice";
import { PlatformUpdates } from "@/components/app/platform-updates";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { PageHeader, Panel } from "@/components/ui/panel";
import { teamPath } from "@/lib/team-path";

export function DeploymentSettings({ teamId }: { teamId: string }) {
	return (
		<div className="max-w-4xl space-y-8">
			<PageHeader title="Settings" />
			<ConnectionNotice />
			<PlatformUpdates />

			<Panel className="space-y-3">
				<h2 className="font-semibold">Automation and environment</h2>
				<p className="text-sm text-muted-foreground">
					Manage scoped credentials and the environment applied to new
					sandboxes.
				</p>
				<div className="flex flex-wrap gap-3">
					<Button asChild variant="outline">
						<Link href={teamPath(teamId, "keys")}>API keys</Link>
					</Button>
					<Button asChild variant="outline">
						<Link href={teamPath(teamId, "environments")}>Environment</Link>
					</Button>
				</div>
			</Panel>
			<SshKeys />
		</div>
	);
}
