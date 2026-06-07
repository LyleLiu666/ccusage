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
import { loadTokenUsageEvents } from '../data-loader.ts';
import { normalizeFilterDate, toFilterStartTimestamp } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { buildMonthlyReport } from '../monthly-report.ts';
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

function getMonthlyModelBreakdownVisibility(values: { breakdown?: boolean }): {
	showRowBreakdown: boolean;
	showTotalBreakdown: boolean;
} {
	return {
		showRowBreakdown: true,
		showTotalBreakdown: values.breakdown === true,
	};
}

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show Codex token usage grouped by month',
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
			log(
				jsonOutput ? JSON.stringify({ monthly: [], totals: null }) : 'No Codex usage data found.',
			);
			return;
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline,
			speed,
		});
		try {
			const rows = await buildMonthlyReport(events, {
				pricingSource,
				timezone: ctx.values.timezone,
				locale: ctx.values.locale,
				since,
				until,
			});

			if (rows.length === 0) {
				log(
					jsonOutput
						? JSON.stringify({ monthly: [], totals: null })
						: 'No Codex usage data found for provided filters.',
				);
				return;
			}

			const totals = calculateCodexReportTotals(rows);

			if (jsonOutput) {
				log(
					JSON.stringify(
						{
							monthly: rows,
							totals,
						},
						null,
						2,
					),
				);
				return;
			}

			logger.box(
				`Codex Token Usage Report - Monthly (Timezone: ${ctx.values.timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					'Month',
					'Models',
					'Input',
					'Output',
					'Reasoning',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
				],
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
				compactHead: ['Month', 'Models', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'right', 'right', 'right'],
				compactThreshold: 100,
				forceCompact: ctx.values.compact,
				style: { head: ['cyan'] },
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
			});
			const modelBreakdownVisibility = getMonthlyModelBreakdownVisibility(ctx.values);
			const showRowBreakdown = modelBreakdownVisibility.showRowBreakdown;

			for (const row of rows) {
				const split = splitUsageTokens(row);

				table.push([
					row.month,
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
	describe('getMonthlyModelBreakdownVisibility', () => {
		it('shows per-month model breakdown by default without expanding totals', () => {
			expect(getMonthlyModelBreakdownVisibility({ breakdown: false })).toEqual({
				showRowBreakdown: true,
				showTotalBreakdown: false,
			});
		});

		it('also expands totals when explicitly requested', () => {
			expect(getMonthlyModelBreakdownVisibility({ breakdown: true })).toEqual({
				showRowBreakdown: true,
				showTotalBreakdown: true,
			});
		});
	});
}
