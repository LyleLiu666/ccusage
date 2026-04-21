import type { UsageReportConfig } from '@ccusage/terminal/table';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import * as configLoaderModule from '../_config-loader-tokens.ts';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_LOCALE } from '../_consts.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import {
	createActivityDate,
	createProjectPath,
	createSessionId,
	createVersion,
} from '../_types.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import * as dataLoaderModule from '../data-loader.ts';
import { loadSessionData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import * as loggerModule from '../logger.ts';
import { log, logger } from '../logger.ts';
import { handleSessionIdLookup } from './_session_id.ts';

// eslint-disable-next-line ts/no-unused-vars
const { order: _, ...sharedArgs } = sharedCommandConfig.args;

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	...sharedCommandConfig,
	args: {
		...sharedArgs,
		id: {
			type: 'string',
			short: 'i',
			description: 'Load usage data for a specific session ID',
		},
	},
	toKebab: true,
	async run(ctx): Promise<void> {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions: typeof ctx.values = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = mergedOptions.json || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Handle specific session ID lookup
		if (mergedOptions.id != null) {
			return handleSessionIdLookup(
				{
					values: {
						id: mergedOptions.id,
						mode: mergedOptions.mode,
						offline: mergedOptions.offline,
						jq: mergedOptions.jq,
						timezone: mergedOptions.timezone,
						locale: mergedOptions.locale ?? DEFAULT_LOCALE,
					},
				},
				useJson,
			);
		}

		// Original session listing logic
		const sessionData = await loadSessionData({
			since: mergedOptions.since,
			until: mergedOptions.until,
			mode: mergedOptions.mode,
			offline: mergedOptions.offline,
			timezone: mergedOptions.timezone,
			locale: mergedOptions.locale,
		});

		if (sessionData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map((data) => ({
					sessionId: data.sessionId,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					lastActivity: data.lastActivity,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
					projectPath: data.projectPath,
				})),
				totals: createTotalsObject(totals),
			};

			// Process with jq if specified
			if (mergedOptions.jq != null) {
				const jqResult = await processWithJq(jsonOutput, mergedOptions.jq);
				if (Result.isFailure(jqResult)) {
					logger.error(jqResult.error.message);
					process.exit(1);
				}
				log(jqResult.value);
			} else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		} else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Session',
				includeLastActivity: true,
				dateFormatter: (dateStr: string) =>
					formatDateCompact(dateStr, mergedOptions.timezone, mergedOptions.locale),
				forceCompact: mergedOptions.compact,
			};
			const table = createUsageReportTable(tableConfig);

			// Add session data
			let maxSessionLength = 0;
			for (const data of sessionData) {
				const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				// Main row
				const row = formatUsageDataRow(
					sessionDisplay,
					{
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalCost: data.totalCost,
						modelsUsed: data.modelsUsed,
					},
					data.lastActivity,
				);
				table.push(row);

				// Add model breakdown rows if flag is set
				if (mergedOptions.breakdown) {
					// Session has 1 extra column before data and 1 trailing column
					pushBreakdownRows(table, data.modelBreakdowns, 1, 1);
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, 9);

			// Add totals
			const totalsRow = formatTotalsRow(
				{
					inputTokens: totals.inputTokens,
					outputTokens: totals.outputTokens,
					cacheCreationTokens: totals.cacheCreationTokens,
					cacheReadTokens: totals.cacheReadTokens,
					totalCost: totals.totalCost,
				},
				true,
			); // Include Last Activity column
			table.push(totalsRow);

			log(table.toString());

			// Show guidance message if in compact mode
			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});

// Note: Tests for --id functionality are covered by the existing loadSessionUsageById tests
// in data-loader.ts, since this command directly uses that function.

if (import.meta.vitest != null) {
	describe('sessionCommand', () => {
		afterEach(() => {
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
		});

		it('uses merged config options when loading session listings', async () => {
			vi.spyOn(configLoaderModule, 'loadConfig').mockReturnValue(undefined);
			vi.spyOn(configLoaderModule, 'mergeConfigWithArgs').mockReturnValue({
				config: '/tmp/config.json',
				debug: false,
				debugSamples: 5,
				json: true,
				jq: undefined,
				id: undefined,
				since: '20240115',
				until: undefined,
				mode: 'display',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
				compact: true,
				breakdown: false,
			});

			const loadSessionDataSpy = vi.spyOn(dataLoaderModule, 'loadSessionData').mockResolvedValue([
				{
					sessionId: createSessionId('session-2'),
					projectPath: createProjectPath('project1'),
					inputTokens: 200,
					outputTokens: 100,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.02,
					lastActivity: createActivityDate('2024-01-20'),
					versions: [createVersion('1.0.0')],
					modelsUsed: [],
					modelBreakdowns: [],
				},
			]);
			const logSpy = vi.spyOn(loggerModule, 'log').mockImplementation(() => {});

			if (sessionCommand.run == null) {
				throw new Error('sessionCommand.run is not defined');
			}

			await sessionCommand.run({
				name: 'session',
				tokens: [],
				values: {
					config: undefined,
					debug: false,
					debugSamples: 5,
					json: false,
					jq: undefined,
					id: undefined,
					since: undefined,
					until: undefined,
					mode: 'auto',
					offline: false,
					timezone: undefined,
					locale: DEFAULT_LOCALE,
					compact: false,
					breakdown: false,
				},
			} as never);

			expect(loadSessionDataSpy).toHaveBeenCalledWith({
				since: '20240115',
				until: undefined,
				mode: 'display',
				offline: true,
				timezone: 'UTC',
				locale: 'en-US',
			});
			expect(logSpy).toHaveBeenCalled();
		});
	});
}
