// `sbx completion bash|zsh|fish|powershell`: a completion script made from
// the command tree at run time, so every registered command and its long
// options are included. Two levels: `sbx <cmd>` and `sbx <cmd> <sub>`.

import type { Command } from "commander";
import { usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";

export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
type Shell = (typeof SHELLS)[number];

interface Node {
	name: string;
	description: string;
	options: string[];
	subs: Node[];
}

function nodeOf(c: Command, inherited: string[]): Node {
	const own = c.options
		.map((o) => o.long)
		.filter((l): l is string => l !== undefined);
	const options = [...new Set([...own, ...inherited, "--help"])];
	return {
		name: c.name(),
		description: c.description().split("\n")[0] ?? "",
		options,
		subs: c.commands
			.filter((s) => s.name() !== "help")
			.map((s) => nodeOf(s, inherited)),
	};
}

export function completionTree(program: Command): Node {
	const globals = program.options
		.map((o) => o.long)
		.filter((l): l is string => l !== undefined);
	return nodeOf(program, globals);
}

const q = (s: string) => s.replaceAll("'", "'\\''");

function bash(t: Node): string {
	const cases = t.subs
		.map((c) => {
			const subs = c.subs.map((s) => s.name).join(" ");
			const subCases = c.subs
				.map((s) => `        ${s.name}) words='${s.options.join(" ")}' ;;`)
				.join("\n");
			const inner =
				c.subs.length === 0
					? `      words='${c.options.join(" ")}'`
					: `      if [ "$COMP_CWORD" -eq 2 ]; then words='${subs} ${c.options.join(" ")}'; else
      case "\${COMP_WORDS[2]}" in
${subCases}
        *) words='${c.options.join(" ")}' ;;
      esac; fi`;
			return `    ${c.name})\n${inner}\n      ;;`;
		})
		.join("\n");
	return `# sbx completion for bash: source <(sbx completion bash)
_sbx() {
  local cur words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    words='${t.subs.map((c) => c.name).join(" ")} ${t.options.join(" ")}'
  else
    case "\${COMP_WORDS[1]}" in
${cases}
    *) words='${t.options.join(" ")}' ;;
    esac
  fi
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -o default -F _sbx sbx
`;
}

function zsh(t: Node): string {
	const described = (ns: Node[]) =>
		ns
			.map((n) => `'${q(n.name)}:${q(n.description.replaceAll(":", "\\:"))}'`)
			.join(" ");
	const cases = t.subs
		.map((c) => {
			const subCases = c.subs
				.map((s) => `          ${s.name}) compadd -- ${s.options.join(" ")} ;;`)
				.join("\n");
			const body =
				c.subs.length === 0
					? `        compadd -- ${c.options.join(" ")}`
					: `        if (( CURRENT == 3 )); then
          local -a subs; subs=(${described(c.subs)}); _describe 'command' subs
          compadd -- ${c.options.join(" ")}
        else
          case $words[3] in
${subCases}
          *) compadd -- ${c.options.join(" ")} ;;
          esac
        fi`;
			return `      ${c.name})\n${body}\n        ;;`;
		})
		.join("\n");
	return `#compdef sbx
# sbx completion for zsh: source <(sbx completion zsh)
_sbx() {
  if (( CURRENT == 2 )); then
    local -a cmds; cmds=(${described(t.subs)})
    _describe 'command' cmds
    compadd -- ${t.options.join(" ")}
  else
    case $words[2] in
${cases}
    *) _files ;;
    esac
  fi
}
compdef _sbx sbx
`;
}

function fish(t: Node): string {
	const lines = [
		"# sbx completion for fish: sbx completion fish | source",
		"complete -c sbx -f",
	];
	const top = t.subs.map((c) => c.name).join(" ");
	for (const c of t.subs) {
		lines.push(
			`complete -c sbx -n "not __fish_seen_subcommand_from ${top}" -a ${c.name} -d '${q(c.description)}'`,
		);
		for (const s of c.subs) {
			lines.push(
				`complete -c sbx -n "__fish_seen_subcommand_from ${c.name}" -a ${s.name} -d '${q(s.description)}'`,
			);
		}
		for (const o of c.options) {
			lines.push(
				`complete -c sbx -n "__fish_seen_subcommand_from ${c.name}" -l ${o.slice(2)}`,
			);
		}
	}
	for (const o of t.options) lines.push(`complete -c sbx -l ${o.slice(2)}`);
	return `${lines.join("\n")}\n`;
}

function powershell(t: Node): string {
	const map = t.subs
		.map((c) => {
			const words = [...c.subs.map((s) => s.name), ...c.options];
			return `    '${c.name}' = @(${words.map((w) => `'${w}'`).join(", ")})`;
		})
		.join("\n");
	return `# sbx completion for PowerShell: sbx completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName sbx -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $top = @(${[...t.subs.map((c) => c.name), ...t.options].map((w) => `'${w}'`).join(", ")})
  $sub = @{
${map}
  }
  $elements = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $words = $top
  if ($elements.Count -gt 2 -or ($elements.Count -eq 2 -and $wordToComplete -eq '')) {
    if ($sub.ContainsKey($elements[1])) { $words = $sub[$elements[1]] }
  }
  $words | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function completionScript(shell: Shell, program: Command): string {
	const t = completionTree(program);
	switch (shell) {
		case "bash":
			return bash(t);
		case "zsh":
			return zsh(t);
		case "fish":
			return fish(t);
		case "powershell":
			return powershell(t);
	}
}

export function register(program: Command, run: Runner): void {
	program
		.command("completion")
		.description(
			"print a shell completion script (bash, zsh, fish, powershell)",
		)
		.argument("<shell>", SHELLS.join(" | "))
		.action(
			run(
				async (ctx, args) => {
					const shell = args[0] as string;
					if (!(SHELLS as readonly string[]).includes(shell)) {
						throw usageError(
							`completion: unknown shell ${JSON.stringify(shell)}; use ${SHELLS.join(", ")}`,
						);
					}
					ctx.out.data(completionScript(shell as Shell, program));
				},
				{ rawData: true },
			),
		);
}
