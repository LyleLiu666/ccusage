import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { DEFAULT_TIMEZONE } from '../_consts.ts';
import { sharedArgs } from '../_shared-args.ts';
import {
	calculateCodexReportTotals,
	formatCodexModelBreakdownRows,
	formatModelsList,
	pushCodexModelBreakdownRows,
	splitUsageTokens,
} from '../command-utils.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import {
	formatDisplayDate,
	formatDisplayDateTime,
	normalizeFilterDate,
	toDateKey,
	toFilterStartTimestamp,
} from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CodexPricingSource } from '../pricing.ts';
import { buildSessionReport } from '../session-report.ts';

const TABLE_COLUMN_COUNT = 12;
const MODEL_BREAKDOWN_COLUMNS = {
	totalColumns: TABLE_COLUMN_COUNT,
	labelColumn: 4,
	inputColumn: 5,
	outputColumn: 6,
	reasoningColumn: 7,
	cacheReadColumn: 8,
	totalTokensColumn: 9,
	costColumn: 10,
};

function getSessionModelBreakdownVisibility(values: { breakdown?: boolean }): {
	showRowBreakdown: boolean;
	showTotalBreakdown: boolean;
} {
	return {
		showRowBreakdown: true,
		showTotalBreakdown: values.breakdown === true,
	};
}

function formatStorageSourceLabel(storageSource: string): string {
	if (storageSource === 'archived') {
		return 'Archived';
	}

	if (storageSource === 'active') {
		return 'Active';
	}

	return 'Custom';
}

function formatSessionDateRange(
	firstActivity: string,
	lastActivity: string,
	locale?: string,
	timezone?: string,
): string {
	const firstDateKey = toDateKey(firstActivity, timezone);
	const lastDateKey = toDateKey(lastActivity, timezone);

	if (firstDateKey === lastDateKey) {
		return formatDisplayDate(lastDateKey, locale, timezone);
	}

	return `${formatDisplayDate(firstDateKey, locale, timezone)} -> ${formatDisplayDate(lastDateKey, locale, timezone)}`;
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show Codex token usage grouped by session',
	args: sharedArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let since: string | undefined;
		let until: string | undefined;
		let sinceTimestamp: number | undefined;

		try {
			since = normalizeFilterDate(ctx.values.since);
			until = normalizeFilterDate(ctx.values.until);
			if (since != null) {
				sinceTimestamp = toFilterStartTimestamp(since, ctx.values.timezone);
			}
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const { events, missingDirectories } = await loadTokenUsageEvents({ sinceTimestamp });

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			log(
				jsonOutput ? JSON.stringify({ sessions: [], totals: null }) : 'No Codex usage data found.',
			);
			return;
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline,
		});
		try {
			const rows = await buildSessionReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
			});

			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify({ sessions: [], totals: null })
						: 'No Codex usage data found for provided filters.',
				);
				return;
			}

			const totals = calculateCodexReportTotals(rows);

			if (jsonOutput) {
				log(
					JSON.stringify(
						{
							sessions: rows,
							totals,
						},
						null,
						2,
					),
				);
				return;
			}

			logger.box(
				`Codex Token Usage Report - Sessions (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					'Dates',
					'Source',
					'Directory',
					'Session',
					'Models',
					'Input',
					'Output',
					'Reasoning',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
					'Last Activity',
				],
				colAligns: [
					'left',
					'left',
					'left',
					'left',
					'left',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'left',
				],
				compactHead: ['Dates', 'Source', 'Session', 'Models', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'left', 'left', 'right', 'right', 'right'],
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});
			const modelBreakdownVisibility = getSessionModelBreakdownVisibility(ctx.values);
			const showRowBreakdown = modelBreakdownVisibility.showRowBreakdown;

			for (const row of rows) {
				const split = splitUsageTokens(row);

				const displayDate = formatSessionDateRange(
					row.firstActivity,
					row.lastActivity,
					ctx.values.locale,
					ctx.values.timezone,
				);
				const directoryDisplay = row.directory === '' ? '-' : row.directory;
				const sessionFile = row.sessionFile;
				const shortSession = sessionFile.length > 8 ? `…${sessionFile.slice(-8)}` : sessionFile;

				table.push([
					displayDate,
					formatStorageSourceLabel(row.storageSource),
					directoryDisplay,
					shortSession,
					showRowBreakdown ? '' : formatModelsDisplayMultiline(formatModelsList(row.models)),
					formatNumber(split.inputTokens),
					formatNumber(split.outputTokens),
					formatNumber(split.reasoningTokens),
					formatNumber(split.cacheReadTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.costUSD),
					formatDisplayDateTime(row.lastActivity, ctx.values.locale, ctx.values.timezone),
				]);
				if (showRowBreakdown) {
					pushCodexModelBreakdownRows(table, row.models, MODEL_BREAKDOWN_COLUMNS);
				}
			}

			const totalsSplit = splitUsageTokens(totals);
			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				'',
				'',
				'',
				pc.yellow('Total'),
				'',
				pc.yellow(formatNumber(totalsSplit.inputTokens)),
				pc.yellow(formatNumber(totalsSplit.outputTokens)),
				pc.yellow(formatNumber(totalsSplit.reasoningTokens)),
				pc.yellow(formatNumber(totalsSplit.cacheReadTokens)),
				pc.yellow(formatNumber(totals.totalTokens)),
				pc.yellow(formatCurrency(totals.costUSD)),
				'',
			]);
			if (modelBreakdownVisibility.showTotalBreakdown) {
				pushCodexModelBreakdownRows(table, totals.models, MODEL_BREAKDOWN_COLUMNS);
			}

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info(
					'Expand terminal width to see directories, cache metrics, total tokens, and last activity',
				);
			}
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});

if (import.meta.vitest != null) {
	describe('getSessionModelBreakdownVisibility', () => {
		it('shows per-session model breakdown by default without expanding totals', () => {
			expect(getSessionModelBreakdownVisibility({ breakdown: false })).toEqual({
				showRowBreakdown: true,
				showTotalBreakdown: false,
			});
		});

		it('also expands totals when explicitly requested', () => {
			expect(getSessionModelBreakdownVisibility({ breakdown: true })).toEqual({
				showRowBreakdown: true,
				showTotalBreakdown: true,
			});
		});
	});

	describe('MODEL_BREAKDOWN_COLUMNS', () => {
		it('places model breakdown labels under the Models column', () => {
			const [row] = formatCodexModelBreakdownRows(
				{
					'gpt-5': {
						inputTokens: 100,
						cachedInputTokens: 20,
						outputTokens: 40,
						reasoningOutputTokens: 10,
						totalTokens: 140,
						costUSD: 0.001,
					},
				},
				MODEL_BREAKDOWN_COLUMNS,
			);

			expect(row?.[3]).toBe('');
			expect(row?.[4]).toBe('  - gpt-5');
		});
	});

	describe('formatSessionDateRange', () => {
		it('returns a single date when the session stays on one local day', () => {
			expect(
				formatSessionDateRange(
					'2025-09-12T01:00:00.000Z',
					'2025-09-12T08:00:00.000Z',
					'en-US',
					'UTC',
				),
			).toBe('Sep 12, 2025');
		});

		it('returns a date range when the session spans multiple local days', () => {
			expect(
				formatSessionDateRange(
					'2025-09-11T23:30:00.000Z',
					'2025-09-12T08:00:00.000Z',
					'en-US',
					'UTC',
				),
			).toBe('Sep 11, 2025 -> Sep 12, 2025');
		});
	});
}
