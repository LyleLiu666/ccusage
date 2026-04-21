import type { CostMode } from '../_types.ts';
import type { UsageData } from '../data-loader.ts';
import process from 'node:process';
import { formatCurrency, formatNumber, ResponsiveTable } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { createISOTimestamp, createModelName, createSessionId } from '../_types.ts';
import * as dataLoaderModule from '../data-loader.ts';
import { loadSessionUsageById } from '../data-loader.ts';
import * as loggerModule from '../logger.ts';
import { log, logger } from '../logger.ts';

export type SessionIdContext = {
	values: {
		id: string;
		mode: CostMode;
		offline: boolean;
		jq?: string;
		timezone?: string;
		locale: string; // normalized to non-optional to avoid touching data-loader
	};
};

/**
 * Handles the session ID lookup and displays usage data.
 */
export async function handleSessionIdLookup(
	ctx: SessionIdContext,
	useJson: boolean,
): Promise<void> {
	const sessionUsage = await loadSessionUsageById(ctx.values.id, {
		mode: ctx.values.mode,
		offline: ctx.values.offline,
	});

	if (sessionUsage == null) {
		if (useJson) {
			log(JSON.stringify(null));
		} else {
			logger.warn(`No session found with ID: ${ctx.values.id}`);
		}
		process.exit(0);
	}

	if (useJson) {
		const jsonOutput = {
			sessionId: ctx.values.id,
			totalCost: sessionUsage.totalCost,
			totalTokens: calculateSessionTotalTokens(sessionUsage.entries),
			entries: sessionUsage.entries.map((entry) => ({
				timestamp: entry.timestamp,
				inputTokens: entry.message.usage.input_tokens,
				outputTokens: entry.message.usage.output_tokens,
				cacheCreationTokens: entry.message.usage.cache_creation_input_tokens ?? 0,
				cacheReadTokens: entry.message.usage.cache_read_input_tokens ?? 0,
				model: entry.message.model ?? 'unknown',
				costUSD: entry.resolvedCost,
			})),
		};

		if (ctx.values.jq != null) {
			const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
			if (Result.isFailure(jqResult)) {
				logger.error(jqResult.error.message);
				process.exit(1);
			}
			log(jqResult.value);
		} else {
			log(JSON.stringify(jsonOutput, null, 2));
		}
	} else {
		logger.box(`Claude Code Session Usage - ${ctx.values.id}`);

		const totalTokens = calculateSessionTotalTokens(sessionUsage.entries);

		log(`Total Cost: ${formatCurrency(sessionUsage.totalCost)}`);
		log(`Total Tokens: ${formatNumber(totalTokens)}`);
		log(`Total Entries: ${sessionUsage.entries.length}`);
		log('');

		if (sessionUsage.entries.length > 0) {
			const table = new ResponsiveTable({
				head: ['Timestamp', 'Model', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Cost (USD)'],
				style: { head: ['cyan'] },
				colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
			});

			for (const entry of sessionUsage.entries) {
				table.push([
					formatDateCompact(entry.timestamp, ctx.values.timezone, ctx.values.locale),
					entry.message.model ?? 'unknown',
					formatNumber(entry.message.usage.input_tokens),
					formatNumber(entry.message.usage.output_tokens),
					formatNumber(entry.message.usage.cache_creation_input_tokens ?? 0),
					formatNumber(entry.message.usage.cache_read_input_tokens ?? 0),
					formatCurrency(entry.resolvedCost),
				]);
			}

			log(table.toString());
		}
	}
}

function calculateSessionTotalTokens(entries: UsageData[]): number {
	return entries.reduce((sum, entry) => {
		const usage = entry.message.usage;
		return (
			sum +
			usage.input_tokens +
			usage.output_tokens +
			(usage.cache_creation_input_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0)
		);
	}, 0);
}

if (import.meta.vitest != null) {
	describe('handleSessionIdLookup', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('uses calculated entry costs in JSON output when costUSD is missing', async () => {
			vi.spyOn(dataLoaderModule, 'loadSessionUsageById').mockResolvedValue({
				totalCost: 0.0105,
				entries: [
					{
						timestamp: createISOTimestamp('2024-01-01T00:00:00Z'),
						sessionId: createSessionId('session-123'),
						message: {
							usage: {
								input_tokens: 1000,
								output_tokens: 500,
							},
							model: createModelName('claude-sonnet-4-20250514'),
						},
						resolvedCost: 0.0105,
					},
				],
			});
			const logSpy = vi.spyOn(loggerModule, 'log').mockImplementation(() => {});

			await handleSessionIdLookup(
				{
					values: {
						id: 'session-123',
						mode: 'calculate',
						offline: true,
						locale: 'en-US',
					},
				},
				true,
			);

			const output = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
				entries: Array<{ costUSD: number }>;
			};
			expect(output.entries[0]?.costUSD).toBe(0.0105);
		});
	});
}
