# Umiak MCP

Use `umiak mcp` for stdio after `umiak login` has paired the CLI with the owner
browser. The SDK reads that same private CLI profile. Scoped API keys are also
accepted through `UMIAK_API_KEY`. Agents receive sandbox tools and computer-use
operations through the public API, with the same scopes and quotas.

Remote MCP is available at the installer tailnet origin's `/mcp` path. It is
private behind the owner ingress. Configure a paired credential in your client's
secret environment; there is no separate browser authorization server or public
MCP listener. Prefer stdio to avoid transferring credentials between clients.

The root Compose stack runs MCP on the control network, reachable only by the
trusted owner ingress. Host, Origin, ingress-network and request-size guards
apply before tool execution. Credentials and results are never logged.

See [getting started](../../docs/getting-started.md) for client configuration,
including Claude Code and Codex, and [architecture](../../docs/architecture.md).

Capacity waits: `sandbox_create`, `sandbox_resume` and `sandbox_fork` accept
`capacity_wait_seconds` (0..604800). `wait_seconds` bounds the tool call; the
server keeps its ticket after that call returns. Inspect queued/moving progress
with `sandbox_get`; `sandbox_cancel_start` cancels an unadmitted request.
