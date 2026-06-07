# Codex Daily Report (Beta)

The `daily` command mirrors ccusage's daily report but operates on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx @ccusage/codex@latest daily

# Using npx
npx @ccusage/codex@latest daily
```

## Options

| Flag                         | Description                                                    |
| ---------------------------- | -------------------------------------------------------------- |
| `--since` / `--until`        | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD)       |
| `--timezone`                 | Override timezone used for grouping (defaults to system)       |
| `--locale`                   | Adjust date formatting locale                                  |
| `--json`                     | Emit structured JSON instead of a table                        |
| `--offline` / `--no-offline` | Force cached LiteLLM pricing or enable live fetching           |
| `--speed`                    | Choose `auto`, `standard`, or `fast` Codex pricing             |
| `--compact`                  | Force compact table layout (same columns as a narrow terminal) |
| `--breakdown`                | Add per-model token and cost rows, including totals            |

The output uses the same responsive table component as ccusage, including compact mode support and per-model token summaries. Add `--breakdown` when you need to see how much each model contributed on a specific day.

Need higher-level trends? Switch to the [monthly report](./monthly.md) for month-by-month rollups. Need chart-friendly recent buckets? Use `recent --hours 24 --interval 60 --json`.
