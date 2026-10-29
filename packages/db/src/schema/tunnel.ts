// Drizzle description of schema `tunnel`, owned by S2
// (db/migrations/0100_tunnel_init.sql). Described here only for types and
// queries (S6 §5.10); the drift test keeps it equal to the migration.
import { bigint, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { bytea, tstz } from "./types.ts";

export const tunnel = pgSchema("tunnel");

export const gatewayInstances = tunnel.table("gateway_instances", {
	id: text("id").primaryKey(),
	internalUrl: text("internal_url").notNull(),
	state: text("state", { enum: ["active", "draining"] }).notNull(),
	startedAt: tstz("started_at").notNull(),
	heartbeatAt: tstz("heartbeat_at").notNull(),
	drainStartedAt: tstz("drain_started_at"),
});

export const tunnelSessions = tunnel.table("tunnel_sessions", {
	machineId: uuid("machine_id").primaryKey(),
	instanceId: text("instance_id").notNull(),
	epoch: bigint("epoch", { mode: "number" }).notNull(),
	connId: text("conn_id").notNull(),
	agentInstanceId: text("agent_instance_id").notNull(),
	bootId: text("boot_id").notNull(),
	vmgenid: text("vmgenid").notNull(),
	agentVersion: text("agent_version").notNull(),
	protoVersion: text("proto_version").notNull(),
	// NULL: unknown until the agent reports them (Control/Info).
	capabilities: text("capabilities").array(),
	state: text("state", { enum: ["connected", "disconnected"] }).notNull(),
	connectedAt: tstz("connected_at").notNull(),
	disconnectedAt: tstz("disconnected_at"),
});

export const tunnelCredentials = tunnel.table("tunnel_credentials", {
	machineId: uuid("machine_id").primaryKey(),
	bsHash: bytea("bs_hash").notNull(),
	mtHash: bytea("mt_hash"),
	mtNextHash: bytea("mt_next_hash"),
	mtIssuedAt: tstz("mt_issued_at"),
	retiredAt: tstz("retired_at"),
});
