# Codex CLI Overview (Beta)

![Codex CLI daily report](/codex-cli.jpeg)

> ⚠️ The Codex companion CLI is experimental. Expect breaking changes while both ccusage and [OpenAI's Codex CLI](https://github.com/openai/codex) continue to evolve.

The `@ccusage/codex` package reuses ccusage's responsive tables, pricing cache, and token accounting to analyze OpenAI Codex CLI session logs.

## Installation & Launch

```bash
# Recommended - always include @latest
npx @ccusage/codex@latest --help
bunx @ccusage/codex@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @ccusage/codex --help
pnpx @ccusage/codex --help

# Using deno (with security flags)
deno run -E -R=$HOME/.codex/ -S=homedir -N='raw.githubusercontent.com:443' npm:@ccusage/codex@latest --help
```

::: warning ⚠️ Critical for bunx users
Bun 1.2.x's bunx prioritizes binaries matching the package name suffix when given a scoped package. For `@ccusage/codex`, it looks for a `codex` binary in PATH first. If you have an existing `codex` command installed (e.g., GitHub Copilot's codex), that will be executed instead. **Always use `bunx @ccusage/codex@latest` with the version tag** to force bunx to fetch and run the correct package.
:::

### Recommended: Shell Alias

Since `npx @ccusage/codex@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias for convenience:

```bash
# bash/zsh: alias ccusage-codex='bunx @ccusage/codex@latest'
# fish:     alias ccusage-codex 'bunx @ccusage/codex@latest'

# Then simply run:
ccusage-codex daily
ccusage-codex recent --hours 24 --interval 60
ccusage-codex monthly --json
```

::: tip
After adding the alias to your shell config file (`.bashrc`, `.zshrc`, or `config.fish`), restart your shell or run `source` on the config file to apply the changes.
:::

## Data Source

The CLI reads Codex session JSONL files located under `CODEX_HOME` (defaults to `~/.codex`). Each file represents a single Codex CLI session and contains running token totals that the tool converts into per-turn deltas for daily, monthly, recent, and session reports.

## What Gets Calculated

- **Token deltas** – Each `event_msg` with `payload.type === "token_count"` reports cumulative totals. The CLI subtracts the previous totals to recover per-turn token usage (input, cached input, output, reasoning, total).
- **Per-model grouping** – The `turn_context` metadata specifies the active model. We aggregate tokens per day/month and per model. Sessions lacking model metadata (seen in early September 2025 builds) are skipped.
- **Pricing** – Rates come from LiteLLM's pricing dataset via the shared `LiteLLMPricingFetcher`. Aliases such as `gpt-5-codex` map to canonical entries (`gpt-5`) so cost calculations remain accurate.
- **Legacy fallback** – Early September 2025 logs that never recorded `turn_context` metadata are still included; the CLI assumes `gpt-5` for pricing so you can review the tokens even though the model tag is missing (the JSON output also marks these rows with `"isFallback": true`).
- **Cost formula** – Non-cached input uses the standard input price; cached input uses the cache-read price (falling back to the input price when missing); and output tokens are billed at the output price. All prices are per million tokens. Reasoning tokens may be shown for reference, but they are part of the output charge and are not billed separately.
- **Totals and reports** – Daily, monthly, recent, and session commands display per-model breakdowns, overall totals, and optional JSON for automation.

## Recent Usage and Dashboard Integration

Use `recent` when you need to answer questions like "what did each model cost yesterday afternoon?" or when you want frontend charts with stable time buckets.

```bash
# 24 one-hour buckets, readable in narrow terminals
ccusage-codex recent --hours 24 --interval 60 --compact

# 48 half-hour buckets for a dashboard chart
ccusage-codex recent --hours 24 --interval 30 --json

# Include per-model rows in the terminal table
ccusage-codex recent --hours 24 --interval 60 --breakdown
```

JSON output is shaped for charting. Each row has `startTime`, `endTime`, aggregate token and cost fields, `calls`, and a `models` object keyed by model name. The `totals.models` object keeps the same per-model token, cost, and call fields, so a frontend does not need to recompute model totals before rendering a legend, summary strip, or stacked chart.

<!-- eslint-skip -->

```json
{
	"recent": [
		{
			"startTime": "2026-06-06T09:00:00.000Z",
			"endTime": "2026-06-06T10:00:00.000Z",
			"calls": 42,
			"inputTokens": 120000,
			"cachedInputTokens": 90000,
			"outputTokens": 8000,
			"reasoningOutputTokens": 1200,
			"totalTokens": 128000,
			"costUSD": 1.23,
			"models": {
				"gpt-5.4": {
					"calls": 18,
					"inputTokens": 50000,
					"cachedInputTokens": 35000,
					"outputTokens": 3000,
					"reasoningOutputTokens": 500,
					"totalTokens": 53000,
					"costUSD": 0.46,
					"isFallback": false
				},
				"gpt-5.5": {
					"calls": 24,
					"inputTokens": 70000,
					"cachedInputTokens": 55000,
					"outputTokens": 5000,
					"reasoningOutputTokens": 700,
					"totalTokens": 75000,
					"costUSD": 0.77,
					"isFallback": false
				}
			}
		}
	],
	"totals": {
		"calls": 42,
		"inputTokens": 120000,
		"cachedInputTokens": 90000,
		"outputTokens": 8000,
		"reasoningOutputTokens": 1200,
		"totalTokens": 128000,
		"costUSD": 1.23,
		"models": {
			"gpt-5.4": {
				"calls": 18,
				"totalTokens": 53000,
				"costUSD": 0.46,
				"isFallback": false
			},
			"gpt-5.5": {
				"calls": 24,
				"totalTokens": 75000,
				"costUSD": 0.77,
				"isFallback": false
			}
		}
	},
	"window": {
		"hours": 24,
		"intervalMinutes": 60,
		"startTime": "2026-06-06T09:00:00.000Z",
		"endTime": "2026-06-07T09:00:00.000Z"
	}
}
```

## Environment Variables

| Variable     | Description                                                  |
| ------------ | ------------------------------------------------------------ |
| `CODEX_HOME` | Override the root directory containing Codex session folders |
| `LOG_LEVEL`  | Adjust logging verbosity (0 silent … 5 trace)                |

When Codex emits a model alias (for example `gpt-5-codex`), the CLI automatically resolves it to the canonical LiteLLM pricing entry. No manual override is needed.

## Next Steps

- [Daily report command](./daily.md)
- Recent report command: `ccusage-codex recent --hours 24 --interval 60`
- [Monthly report command](./monthly.md)
- [Session report command](./session.md)
- Additional reports will mirror the ccusage CLI as the Codex tooling stabilizes.

Have feedback or ideas? [Open an issue](https://github.com/ryoppippi/ccusage/issues/new) so we can improve the beta.

## Troubleshooting

::: details Why are there no entries before September 2025?
OpenAI's Codex CLI started emitting `token_count` events in [commit 0269096](https://github.com/openai/codex/commit/0269096229e8c8bd95185173706807dc10838c7a) (2025-09-06). Earlier session logs simply don't contain token usage metrics, so `@ccusage/codex` has nothing to aggregate. If you need historic data, rerun those sessions after that Codex update.
:::

::: details What if some September 2025 sessions still get skipped?
During the 2025-09 rollouts a few Codex builds emitted `token_count` events without the matching `turn_context` metadata, so the CLI could not determine which model generated the tokens. Those entries are ignored to avoid mispriced reports. If you encounter this, relaunch the Codex CLI to generate fresh logs—the current builds restore the missing metadata.
:::
