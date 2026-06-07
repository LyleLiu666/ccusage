# Codex Monthly Report (Beta)

![Codex CLI monthly report](/codex-cli.jpeg)

The `monthly` command mirrors ccusage's monthly report while operating on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx @ccusage/codex@latest monthly

# Using npx
npx @ccusage/codex@latest monthly
```

## Options

| Flag                         | Description                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| `--since` / `--until`        | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD) before aggregating |
| `--timezone`                 | Override the timezone used to bucket usage into months                      |
| `--locale`                   | Adjust month label formatting                                               |
| `--json`                     | Emit structured JSON instead of a table                                     |
| `--offline` / `--no-offline` | Force cached LiteLLM pricing or enable live fetching                        |
| `--speed`                    | Choose `auto`, `standard`, or `fast` Codex pricing                          |
| `--compact`                  | Force compact table layout (same columns as a narrow terminal)              |
| `--breakdown`                | Add per-model token and cost rows, including totals                         |

The output uses the same responsive table component as ccusage, including compact mode support, per-model token summaries, and a combined totals row. Add `--breakdown` when you want to compare model spend month by month.
