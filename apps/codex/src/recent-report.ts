import type { ModelPricing, ModelUsage, PricingSource, TokenUsageEvent } from './_types.ts';
import { addUsage, calculateCostUSD, createEmptyUsage } from './token-utils.ts';

const MINUTE_MS = 60 * 1000;

export type RecentModelUsage = ModelUsage & {
	calls: number;
};

export type RecentReportRow = {
	startTime: string;
	endTime: string;
	calls: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, RecentModelUsage>;
};

export type RecentReportTotals = Omit<RecentReportRow, 'startTime' | 'endTime'>;

export type RecentWindowOptions = {
	hours: number;
	intervalMinutes: number;
	now?: number;
};

export type RecentReportOptions = RecentWindowOptions & {
	pricingSource: PricingSource;
};

function createEmptyRecentModelUsage(): RecentModelUsage {
	return {
		...createEmptyUsage(),
		costUSD: 0,
		calls: 0,
		isFallback: false,
	};
}

function createEmptyRecentRow(startMs: number, endMs: number): RecentReportRow {
	return {
		startTime: new Date(startMs).toISOString(),
		endTime: new Date(endMs).toISOString(),
		calls: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		costUSD: 0,
		models: {},
	};
}

function createEmptyRecentTotals(): RecentReportTotals {
	return {
		...createEmptyUsage(),
		costUSD: 0,
		calls: 0,
		models: {},
	};
}

function addRecentModelUsage(target: RecentModelUsage, usage: RecentModelUsage): void {
	addUsage(target, usage);
	target.costUSD += usage.costUSD;
	target.calls += usage.calls;
	if (usage.isFallback === true) {
		target.isFallback = true;
	}
}

function calculateWindow(options: RecentWindowOptions): {
	startMs: number;
	intervalMs: number;
	binCount: number;
} {
	const intervalMs = options.intervalMinutes * MINUTE_MS;
	const windowMs = options.hours * 60 * MINUTE_MS;
	const binCount = Math.ceil(windowMs / intervalMs);
	const now = options.now ?? Date.now();
	const endMs = Math.ceil(now / intervalMs) * intervalMs;
	return {
		startMs: endMs - binCount * intervalMs,
		intervalMs,
		binCount,
	};
}

export function getRecentWindowStartTimestamp(options: RecentWindowOptions): number {
	return calculateWindow(options).startMs;
}

export async function buildRecentReport(
	events: TokenUsageEvent[],
	options: RecentReportOptions,
): Promise<RecentReportRow[]> {
	const { startMs, intervalMs, binCount } = calculateWindow(options);
	const rows = Array.from({ length: binCount }, (_, index) => {
		const start = startMs + index * intervalMs;
		return createEmptyRecentRow(start, start + intervalMs);
	});

	for (const event of events) {
		const modelName = event.model?.trim();
		if (modelName == null || modelName === '') {
			continue;
		}

		const timestampMs = Date.parse(event.timestamp);
		if (!Number.isFinite(timestampMs)) {
			continue;
		}

		const index = Math.floor((timestampMs - startMs) / intervalMs);
		if (index < 0 || index >= rows.length) {
			continue;
		}

		const row = rows[index]!;
		row.calls += 1;
		addUsage(row, event);

		const modelUsage = row.models[modelName] ?? createEmptyRecentModelUsage();
		if (row.models[modelName] == null) {
			row.models[modelName] = modelUsage;
		}
		modelUsage.calls += 1;
		addUsage(modelUsage, event);
		if (event.isFallbackModel === true) {
			modelUsage.isFallback = true;
		}
	}

	const uniqueModels = new Set<string>();
	for (const row of rows) {
		for (const modelName of Object.keys(row.models)) {
			uniqueModels.add(modelName);
		}
	}

	const modelPricing = new Map<string, Awaited<ReturnType<PricingSource['getPricing']>>>();
	for (const modelName of uniqueModels) {
		modelPricing.set(modelName, await options.pricingSource.getPricing(modelName));
	}

	for (const row of rows) {
		let cost = 0;
		for (const [modelName, usage] of Object.entries(row.models)) {
			const pricing = modelPricing.get(modelName);
			if (pricing == null) {
				continue;
			}
			const modelCost = calculateCostUSD(usage, pricing);
			usage.costUSD = modelCost;
			cost += modelCost;
		}
		row.costUSD = cost;
	}

	return rows;
}

export function calculateRecentReportTotals(rows: RecentReportRow[]): RecentReportTotals {
	const totals = createEmptyRecentTotals();

	for (const row of rows) {
		addUsage(totals, row);
		totals.costUSD += row.costUSD;
		totals.calls += row.calls;

		for (const [modelName, usage] of Object.entries(row.models)) {
			const modelTotals = totals.models[modelName] ?? createEmptyRecentModelUsage();
			if (totals.models[modelName] == null) {
				totals.models[modelName] = modelTotals;
			}
			addRecentModelUsage(modelTotals, usage);
		}
	}

	return totals;
}

if (import.meta.vitest != null) {
	describe('buildRecentReport', () => {
		it('groups recent events into aligned intervals with per-model costs', async () => {
			const pricing = new Map([
				[
					'gpt-5.4',
					{ inputCostPerMToken: 2, cachedInputCostPerMToken: 0.2, outputCostPerMToken: 10 },
				],
				[
					'gpt-5.5',
					{ inputCostPerMToken: 3, cachedInputCostPerMToken: 0.3, outputCostPerMToken: 12 },
				],
			]);
			const stubPricingSource: PricingSource = {
				async getPricing(model: string): Promise<ModelPricing> {
					const value = pricing.get(model);
					if (value == null) {
						throw new Error(`Missing pricing for ${model}`);
					}
					return value;
				},
			};

			const rows = await buildRecentReport(
				[
					{
						sessionId: 'session-a',
						timestamp: '2026-06-06T23:10:00.000Z',
						model: 'gpt-5.4',
						inputTokens: 1_000,
						cachedInputTokens: 100,
						outputTokens: 200,
						reasoningOutputTokens: 20,
						totalTokens: 1_200,
					},
					{
						sessionId: 'session-b',
						timestamp: '2026-06-06T23:20:00.000Z',
						model: 'gpt-5.5',
						inputTokens: 2_000,
						cachedInputTokens: 500,
						outputTokens: 300,
						reasoningOutputTokens: 30,
						totalTokens: 2_300,
					},
					{
						sessionId: 'session-c',
						timestamp: '2026-06-06T22:00:00.000Z',
						model: 'gpt-5.4',
						inputTokens: 99,
						cachedInputTokens: 0,
						outputTokens: 99,
						reasoningOutputTokens: 0,
						totalTokens: 198,
					},
				],
				{
					pricingSource: stubPricingSource,
					hours: 1,
					intervalMinutes: 30,
					now: new Date('2026-06-06T23:45:00.000Z').getTime(),
				},
			);

			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				startTime: '2026-06-06T23:00:00.000Z',
				endTime: '2026-06-06T23:30:00.000Z',
				calls: 2,
				inputTokens: 3_000,
				cachedInputTokens: 600,
				outputTokens: 500,
				reasoningOutputTokens: 50,
				totalTokens: 3_500,
			});
			expect(rows[0]?.models['gpt-5.4']).toMatchObject({
				calls: 1,
				totalTokens: 1_200,
			});
			expect(rows[0]?.models['gpt-5.5']).toMatchObject({
				calls: 1,
				totalTokens: 2_300,
			});
			expect(rows[1]?.calls).toBe(0);
			expect(rows[0]?.costUSD).toBeCloseTo(0.01207, 10);
		});

		it('keeps per-model call counts in recent totals', () => {
			const totals = calculateRecentReportTotals([
				{
					startTime: '2026-06-06T23:00:00.000Z',
					endTime: '2026-06-06T23:30:00.000Z',
					calls: 2,
					inputTokens: 3_000,
					cachedInputTokens: 600,
					outputTokens: 500,
					reasoningOutputTokens: 50,
					totalTokens: 3_500,
					costUSD: 0.012,
					models: {
						'gpt-5.4': {
							calls: 1,
							inputTokens: 1_000,
							cachedInputTokens: 100,
							outputTokens: 200,
							reasoningOutputTokens: 20,
							totalTokens: 1_200,
							costUSD: 0.004,
						},
						'gpt-5.5': {
							calls: 1,
							inputTokens: 2_000,
							cachedInputTokens: 500,
							outputTokens: 300,
							reasoningOutputTokens: 30,
							totalTokens: 2_300,
							costUSD: 0.008,
						},
					},
				},
				{
					startTime: '2026-06-06T23:30:00.000Z',
					endTime: '2026-06-07T00:00:00.000Z',
					calls: 1,
					inputTokens: 500,
					cachedInputTokens: 0,
					outputTokens: 100,
					reasoningOutputTokens: 10,
					totalTokens: 600,
					costUSD: 0.003,
					models: {
						'gpt-5.4': {
							calls: 1,
							inputTokens: 500,
							cachedInputTokens: 0,
							outputTokens: 100,
							reasoningOutputTokens: 10,
							totalTokens: 600,
							costUSD: 0.003,
						},
					},
				},
			]);

			expect(totals.calls).toBe(3);
			expect(totals.models['gpt-5.4']).toMatchObject({
				calls: 2,
				totalTokens: 1_800,
				costUSD: 0.007,
			});
			expect(totals.models['gpt-5.5']).toMatchObject({
				calls: 1,
				totalTokens: 2_300,
				costUSD: 0.008,
			});
		});

		it('calculates the aligned window start timestamp', () => {
			expect(
				new Date(
					getRecentWindowStartTimestamp({
						hours: 24,
						intervalMinutes: 30,
						now: new Date('2026-06-07T10:17:00.000Z').getTime(),
					}),
				).toISOString(),
			).toBe('2026-06-06T10:30:00.000Z');
		});
	});
}
