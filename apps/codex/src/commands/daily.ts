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
import { normalizeSpeedOption, resolveCodexSpeed } from '../codex-config.ts';
import {
	calculateCodexReportTotals,
	formatModelsList,
	pushCodexModelBreakdownRows,
	splitUsageTokens,
} from '../command-utils.ts';
import { buildDailyReport } from '../daily-report.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate, toDateKey, toFilterStartTimestamp } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CodexPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;
const MODEL_BREAKDOWN_COLUMNS = {
	totalColumns: TABLE_COLUMN_COUNT,
	labelColumn: 1,
	inputColumn: 2,
	outputColumn: 3,
	reasoningColumn: 4,
	cacheReadColumn: 5,
	totalTokensColumn: 6,
	costColumn: 7,
};

function getDailyModelBreakdownVisibility(values: { breakdown?: boolean; week?: boolean }): {
	showRowBreakdown: boolean;
	showTotalBreakdown: boolean;
} {
	const showRowBreakdown = values.breakdown === true || values.week === true;
	return {
		showRowBreakdown,
		showTotalBreakdown: values.breakdown === true,
	};
}

function subtractCalendarDays(dateKey: string, days: number): string {
	const [yearStr = '0', monthStr = '1', dayStr = '1'] = dateKey.split('-');
	const date = new Date(
		Date.UTC(
			Number.parseInt(yearStr, 10),
			Number.parseInt(monthStr, 10) - 1,
			Number.parseInt(dayStr, 10),
		),
	);
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
}

function getLastSevenCalendarDaysStartDate(now: number, timezone?: string): string {
	const today = toDateKey(new Date(now).toISOString(), timezone);
	return subtractCalendarDays(today, 6);
}

export const dailyCommand = define({
	name: 'daily',
	description: 'Show Codex token usage grouped by day',
	args: {
		...sharedArgs,
		week: {
			type: 'boolean',
			short: 'w',
			description: 'Show usage for the last 7 days',
			default: false,
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let since: string | undefined;
		let until: string | undefined;
		let sinceTimestamp: number | undefined;

		try {
			if (ctx.values.week) {
				since = getLastSevenCalendarDaysStartDate(Date.now(), ctx.values.timezone);
				sinceTimestamp = toFilterStartTimestamp(since, ctx.values.timezone);
			} else {
				since = normalizeFilterDate(ctx.values.since);
				if (since != null) {
					sinceTimestamp = toFilterStartTimestamp(since, ctx.values.timezone);
				}
			}
			until = normalizeFilterDate(ctx.values.until);
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		let speed;
		try {
			speed = await resolveCodexSpeed(normalizeSpeedOption(ctx.values.speed));
		} catch (error) {
			logger.error(String(error));
			process.exit(1);
		}

		const { events, missingDirectories } = await loadTokenUsageEvents({ sinceTimestamp });

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		if (events.length === 0) {
			log(jsonOutput ? JSON.stringify({ daily: [], totals: null }) : 'No Codex usage data found.');
			return;
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline,
			speed,
		});
		try {
			const rows = await buildDailyReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
			});

			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify({ daily: [], totals: null })
						: 'No Codex usage data found for provided filters.',
				);
				return;
			}

			const totals = calculateCodexReportTotals(rows);

			if (jsonOutput) {
				log(
					JSON.stringify(
						{
							daily: rows,
							totals,
						},
						null,
						2,
					),
				);
				return;
			}

			logger.box(
				`Codex Token Usage Report - Daily (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					'Date',
					'Models',
					'Input',
					'Output',
					'Reasoning',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
				],
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
				compactHead: ['Date', 'Models', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'right', 'right', 'right'],
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});
			const modelBreakdownVisibility = getDailyModelBreakdownVisibility(ctx.values);
			const showRowBreakdown = modelBreakdownVisibility.showRowBreakdown;

			for (const row of rows) {
				const split = splitUsageTokens(row);

				table.push([
					row.date,
					showRowBreakdown ? '' : formatModelsDisplayMultiline(formatModelsList(row.models)),
					formatNumber(split.inputTokens),
					formatNumber(split.outputTokens),
					formatNumber(split.reasoningTokens),
					formatNumber(split.cacheReadTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.costUSD),
				]);
				if (showRowBreakdown) {
					pushCodexModelBreakdownRows(table, row.models, MODEL_BREAKDOWN_COLUMNS);
				}
			}

			const totalsSplit = splitUsageTokens(totals);
			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				pc.yellow('Total'),
				'',
				pc.yellow(formatNumber(totalsSplit.inputTokens)),
				pc.yellow(formatNumber(totalsSplit.outputTokens)),
				pc.yellow(formatNumber(totalsSplit.reasoningTokens)),
				pc.yellow(formatNumber(totalsSplit.cacheReadTokens)),
				pc.yellow(formatNumber(totals.totalTokens)),
				pc.yellow(formatCurrency(totals.costUSD)),
			]);
			if (modelBreakdownVisibility.showTotalBreakdown) {
				pushCodexModelBreakdownRows(table, totals.models, MODEL_BREAKDOWN_COLUMNS);
			}

			log(table.toString());

			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		} finally {
			pricingSource[Symbol.dispose]();
		}
	},
});

if (import.meta.vitest != null) {
	describe('getLastSevenCalendarDaysStartDate', () => {
		it('returns the first date of the 7-day calendar window in the target timezone', () => {
			expect(
				getLastSevenCalendarDaysStartDate(
					new Date('2026-06-06T01:00:00.000Z').getTime(),
					'Asia/Shanghai',
				),
			).toBe('2026-05-31');
		});

		it('handles month boundaries', () => {
			expect(
				getLastSevenCalendarDaysStartDate(new Date('2026-03-01T12:00:00.000Z').getTime(), 'UTC'),
			).toBe('2026-02-23');
		});
	});

	describe('getDailyModelBreakdownVisibility', () => {
		it('shows per-day model breakdown for weekly reports without expanding totals by default', () => {
			expect(getDailyModelBreakdownVisibility({ week: true, breakdown: false })).toEqual({
				showRowBreakdown: true,
				showTotalBreakdown: false,
			});
		});

		it('shows row and total model breakdown when explicitly requested', () => {
			expect(getDailyModelBreakdownVisibility({ week: false, breakdown: true })).toEqual({
				showRowBreakdown: true,
				showTotalBreakdown: true,
			});
		});

		it('keeps regular daily reports compact by default', () => {
			expect(getDailyModelBreakdownVisibility({ week: false, breakdown: false })).toEqual({
				showRowBreakdown: false,
				showTotalBreakdown: false,
			});
		});
	});
}
