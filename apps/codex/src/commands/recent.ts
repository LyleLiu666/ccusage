import type { Args } from 'gunshi';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	formatCurrency,
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
	formatModelsList,
	pushCodexModelBreakdownRows,
	splitUsageTokens,
} from '../command-utils.ts';
import { loadTokenUsageEvents } from '../data-loader.ts';
import { toDateKey } from '../date-utils.ts';
import { log, logger } from '../logger.ts';
import { CodexPricingSource } from '../pricing.ts';
import {
	buildRecentReport,
	calculateRecentReportTotals,
	getRecentWindowStartTimestamp,
} from '../recent-report.ts';

const DEFAULT_RECENT_HOURS = 24;
const DEFAULT_INTERVAL_MINUTES = 30;
const MAX_RECENT_HOURS = 24 * 14;
const TABLE_COLUMN_COUNT = 9;
const MODEL_BREAKDOWN_COLUMNS = {
	totalColumns: TABLE_COLUMN_COUNT,
	labelColumn: 1,
	inputColumn: 3,
	outputColumn: 4,
	reasoningColumn: 5,
	cacheReadColumn: 6,
	totalTokensColumn: 7,
	costColumn: 8,
};

const recentArgs = {
	json: sharedArgs.json,
	timezone: sharedArgs.timezone,
	locale: sharedArgs.locale,
	offline: sharedArgs.offline,
	speed: sharedArgs.speed,
	compact: sharedArgs.compact,
	breakdown: sharedArgs.breakdown,
	color: sharedArgs.color,
	noColor: sharedArgs.noColor,
	hours: {
		type: 'number',
		short: 'H',
		description: `Recent window size in hours (default: ${DEFAULT_RECENT_HOURS})`,
		default: DEFAULT_RECENT_HOURS,
	},
	interval: {
		type: 'number',
		short: 'i',
		description: `Bucket size in minutes (default: ${DEFAULT_INTERVAL_MINUTES})`,
		default: DEFAULT_INTERVAL_MINUTES,
	},
	all: {
		type: 'boolean',
		description: 'Show empty time buckets in table output',
		default: false,
	},
} as const satisfies Args;

function normalizePositiveInteger(value: unknown, name: string): number {
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(number) || number <= 0) {
		throw new Error(`Invalid --${name} value. Use a positive integer.`);
	}

	return number;
}

function normalizeRecentOptions(values: { hours?: unknown; interval?: unknown }): {
	hours: number;
	intervalMinutes: number;
} {
	const hours = normalizePositiveInteger(values.hours ?? DEFAULT_RECENT_HOURS, 'hours');
	const intervalMinutes = normalizePositiveInteger(
		values.interval ?? DEFAULT_INTERVAL_MINUTES,
		'interval',
	);

	if (hours > MAX_RECENT_HOURS) {
		throw new Error(`Invalid --hours value. Use ${MAX_RECENT_HOURS} or less.`);
	}

	if (intervalMinutes > hours * 60) {
		throw new Error('Invalid --interval value. It must be no larger than the recent window.');
	}

	return { hours, intervalMinutes };
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function safeTimeZone(timezone?: string): string {
	if (timezone == null || timezone.trim() === '') {
		return DEFAULT_TIMEZONE;
	}

	try {
		Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return timezone;
	} catch {
		return 'UTC';
	}
}

function getDateTimePart(
	parts: Intl.DateTimeFormatPart[],
	type: Intl.DateTimeFormatPartTypes,
): string {
	return parts.find((part) => part.type === type)?.value ?? '';
}

function formatRecentRangePoint(
	timestamp: string,
	locale?: string,
	timezone?: string,
): {
	dateKey: string;
	dateLabel: string;
	timeLabel: string;
} {
	const timeZone = safeTimeZone(timezone);
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone,
	});
	const parts = formatter.formatToParts(date);
	const month = getDateTimePart(parts, 'month');
	const day = getDateTimePart(parts, 'day');
	const hour = getDateTimePart(parts, 'hour');
	const minute = getDateTimePart(parts, 'minute');

	return {
		dateKey: toDateKey(timestamp, timeZone),
		dateLabel: `${month} ${day}`.trim(),
		timeLabel: `${hour}:${minute}`,
	};
}

function formatRecentRange(
	startTime: string,
	endTime: string,
	locale?: string,
	timezone?: string,
): string {
	const start = formatRecentRangePoint(startTime, locale, timezone);
	const end = formatRecentRangePoint(endTime, locale, timezone);

	if (start.dateKey === end.dateKey) {
		return `${start.dateLabel} ${start.timeLabel}-${end.timeLabel}`;
	}

	return `${start.dateLabel} ${start.timeLabel}-${end.dateLabel} ${end.timeLabel}`;
}

export const recentCommand = define({
	name: 'recent',
	description: 'Show recent Codex token usage grouped by time bucket',
	args: recentArgs,
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		if (jsonOutput) {
			logger.level = 0;
		}

		let recentOptions;
		try {
			recentOptions = normalizeRecentOptions(ctx.values);
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

		const timezone = optionalString(ctx.values.timezone);
		const locale = optionalString(ctx.values.locale);
		const showAllBuckets = ctx.values.all === true;
		const showBreakdown = ctx.values.breakdown === true;
		const forceCompact = ctx.values.compact === true;
		const sinceTimestamp = getRecentWindowStartTimestamp(recentOptions);
		const { events, missingDirectories } = await loadTokenUsageEvents({ sinceTimestamp });

		for (const missing of missingDirectories) {
			logger.warn(`Codex session directory not found: ${missing}`);
		}

		const pricingSource = new CodexPricingSource({
			offline: ctx.values.offline === true,
			speed,
		});
		try {
			const rows = await buildRecentReport(events, {
				pricingSource,
				...recentOptions,
			});
			const totals = calculateRecentReportTotals(rows);
			const firstRow = rows[0];
			const lastRow = rows.at(-1);

			if (jsonOutput) {
				log(
					JSON.stringify(
						{
							recent: rows,
							totals,
							window: {
								...recentOptions,
								startTime: firstRow?.startTime ?? null,
								endTime: lastRow?.endTime ?? null,
							},
						},
						null,
						2,
					),
				);
				return;
			}

			const tableRows = showAllBuckets ? rows : rows.filter((row) => row.calls > 0);
			if (tableRows.length === 0) {
				log('No Codex usage data found in the recent window.');
				return;
			}

			logger.box(
				`Codex Token Usage Report - Recent ${recentOptions.hours}h / ${recentOptions.intervalMinutes}m (Timezone: ${timezone ?? DEFAULT_TIMEZONE})`,
			);

			const table: ResponsiveTable = new ResponsiveTable({
				head: [
					'Time',
					'Models',
					'Calls',
					'Input',
					'Output',
					'Reasoning',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
				],
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
				compactHead: ['Time', 'Models', 'Calls', 'Input', 'Output', 'Cost (USD)'],
				compactColAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
				compactThreshold: 110,
				forceCompact,
				style: { head: ['cyan'] },
			});

			for (const row of tableRows) {
				const split = splitUsageTokens(row);
				table.push([
					formatRecentRange(row.startTime, row.endTime, locale, timezone),
					showBreakdown ? '' : formatModelsDisplayMultiline(formatModelsList(row.models)),
					formatNumber(row.calls),
					formatNumber(split.inputTokens),
					formatNumber(split.outputTokens),
					formatNumber(split.reasoningTokens),
					formatNumber(split.cacheReadTokens),
					formatNumber(row.totalTokens),
					formatCurrency(row.costUSD),
				]);
				if (showBreakdown) {
					pushCodexModelBreakdownRows(table, row.models, MODEL_BREAKDOWN_COLUMNS);
				}
			}

			const totalsSplit = splitUsageTokens(totals);
			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
			table.push([
				pc.yellow('Total'),
				'',
				pc.yellow(formatNumber(totals.calls)),
				pc.yellow(formatNumber(totalsSplit.inputTokens)),
				pc.yellow(formatNumber(totalsSplit.outputTokens)),
				pc.yellow(formatNumber(totalsSplit.reasoningTokens)),
				pc.yellow(formatNumber(totalsSplit.cacheReadTokens)),
				pc.yellow(formatNumber(totals.totalTokens)),
				pc.yellow(formatCurrency(totals.costUSD)),
			]);
			if (showBreakdown) {
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
	describe('normalizeRecentOptions', () => {
		it('accepts default values', () => {
			expect(normalizeRecentOptions({})).toEqual({
				hours: DEFAULT_RECENT_HOURS,
				intervalMinutes: DEFAULT_INTERVAL_MINUTES,
			});
		});

		it('rejects non-positive values', () => {
			expect(() => normalizeRecentOptions({ hours: 0 })).toThrow('Invalid --hours value');
			expect(() => normalizeRecentOptions({ interval: -1 })).toThrow('Invalid --interval value');
		});

		it('rejects intervals larger than the recent window', () => {
			expect(() => normalizeRecentOptions({ hours: 1, interval: 90 })).toThrow(
				'Invalid --interval value',
			);
		});
	});

	describe('formatRecentRange', () => {
		it('uses a compact same-day time range', () => {
			expect(
				formatRecentRange('2026-06-06T17:00:00.000Z', '2026-06-06T18:00:00.000Z', 'en-US', 'UTC'),
			).toBe('Jun 06 17:00-18:00');
		});

		it('includes both dates when the range crosses a local day boundary', () => {
			expect(
				formatRecentRange('2026-06-06T23:00:00.000Z', '2026-06-07T00:00:00.000Z', 'en-US', 'UTC'),
			).toBe('Jun 06 23:00-Jun 07 00:00');
		});
	});
}
