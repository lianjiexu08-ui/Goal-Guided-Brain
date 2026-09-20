# Plugin Compatibility

The workbench imports a verified snapshot of a plugin. Importing files does not imply that every native platform feature is supported. The component list reports commands, assistant templates, MCP entries, and compatibility diagnostics separately.

## Supported Layouts

- Claude Code: `.claude-plugin/plugin.json`, `commands/`, `agents/`, `skills/`, `.mcp.json`, and the supported subset of `hooks/hooks.json`.
- Codex compatibility format: `.codex-plugin/plugin.json`, Skills, `.mcp.json`, and supported lifecycle Hooks.
- Portable OpenAI format: root `plugin.json`, `skills/`, and root `mcp.json` with an `mcpServers` map. Custom UI, app integrations, browser extensions, and other extension fields are not interpreted.

Current official OpenAI plugin documentation specifies Skills, MCP servers, and lifecycle Hooks. It does not define Claude-style `commands/` and `agents/` as native Codex plugin components. The workbench can import those directories when present in a Codex-layout bundle, but labels them as workbench templates.

## Commands

Selecting a command expands its Markdown into a new workbench task. The selected assistant retains its existing model and tool permissions. The plugin's `allowed-tools` and model fields cannot silently grant permissions or change providers.

- Supported: `$ARGUMENTS`, zero-based `$0` and `$ARGUMENTS[0]`, named positional arguments, quoted argument values, and a single substitution pass.
- Missing indexed values remain literal; missing named values become empty. Argument text is appended when the command has no applicable argument placeholder.
- A single backslash escapes an argument placeholder. Argument text is not evaluated as shell code.
- Local `${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`, and `${CLAUDE_SKILL_DIR}` references resolve against the pinned installed bundle.
- Commands using shell preprocessing (`!` followed by backticks or a shell-preprocessing fence), `context: fork`, or disabled user invocation cannot run through this importer. Commands requiring unmapped session variables are rejected.
- Remote tasks can use portable commands without platform path variables. Commands depending on those variables currently require controller-local execution or conversion into a portable Skill.

DSH's installed filesystem skill provider supports flat Markdown and `SKILL.md` discovery but does not implement the complete Claude command preprocessing contract. The workbench therefore performs explicit command expansion instead of claiming native host compatibility.

## Assistant Templates

Template Markdown becomes an editable assistant instruction set. Import preserves source identity, digest, original model hint, requested tool names, denied tool names, and unsupported-field diagnostics. The default imported assistant has file tools enabled, web and terminal tools disabled, and no forced native-platform model name. User-selected overrides use the regular assistant configuration path.

Claude tool patterns do not map exactly to the workbench's coarse file, web, and terminal settings. Review those settings before execution. Fine-grained original platform rules, memory settings, permission modes, and nested MCP definitions do not grant access.

Importing the same template from the same snapshot returns the existing assistant and preserves user edits. A different plugin snapshot produces a separate import.

## Plugin MCP Connections

Plugin MCP entries are imported as independent, disabled connections. Enabling the parent plugin does not start an imported MCP server. Configure credential references, test the connection, and enable it separately.

The importer supports stdio and Streamable HTTP, including Claude's `http` alias. Old SSE and other transport declarations require an explicit supported mapping. Plugin-root references in local command paths are resolved against the installed package.

Inline environment values, authentication headers, credential command arguments, and credential-bearing URLs are rejected before a plugin is copied into the installed capability store. Use variable placeholders in the source package and choose independent vault references in the workbench. Environment entries currently require explicit vault references, including non-secret environment settings. Authorization Bearer is supported; other authenticated header schemes require a separate adapter and cannot be enabled by this importer.

Every MCP tool call passes through the controller gateway. Stdio programs run on the controller, even when their requesting Agent runs remotely. The gateway checks instance identity, pinned configuration, capability binding, tool allowlists, and exact-argument grants for tools that do not declare `readOnlyHint: true`.

`readOnlyHint` is metadata supplied by the selected provider, not independent verification. Binding a third-party server remains a trust decision. The gateway governs MCP invocations; it cannot guarantee the behavior of arbitrary terminal programs or plugin hook scripts. Upstream stdio stderr is not inherited into controller logs, and configured credential literals are redacted from gateway metadata, errors, and results.

## Official References

- [Claude Code plugin components](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code arguments and preprocessing](https://code.claude.com/docs/en/skills)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin overview](https://developers.openai.com/codex/plugins)

These references were checked during implementation. Portable manifests, host-specific components, and authentication conventions may evolve independently; unsupported declarations remain visible as compatibility limitations.
