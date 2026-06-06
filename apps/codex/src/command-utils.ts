import type { ModelUsage, TokenUsageDelta } from './_types.ts';
import { formatCurrency, formatNumber } from '@ccusage/terminal/table';
import { sort } from 'fast-sort';
import pc from 'picocolors';

export type UsageGroup = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

type CodexReportUsage = TokenUsageDelta & {
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type CodexReportRow = CodexReportUsage;
export type CodexReportTotals = CodexReportUsage;

export type CodexModelBreakdownColumns = {
	totalColumns: number;
	labelColumn: number;
	inputColumn: number;
	outputColumn: number;
	reasoningColumn: number;
	cacheReadColumn: number;
	totalTokensColumn: number;
	costColumn: number;
};

export function splitUsageTokens(usage: UsageGroup): {
	inputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
} {
	const cacheReadTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const inputTokens = Math.max(usage.inputTokens - cacheReadTokens, 0);
	const outputTokens = Math.max(usage.outputTokens, 0);
	const rawReasoning = usage.reasoningOutputTokens ?? 0;
	const reasoningTokens = Math.max(0, Math.min(rawReasoning, outputTokens));

	return {
		inputTokens,
		reasoningTokens,
		cacheReadTokens,
		outputTokens,
	};
}

export function formatModelsList(
	models: Record<string, { totalTokens: number; isFallback?: boolean }>,
): string[] {
	return sort(Object.entries(models))
		.asc(([model]) => model)
		.map(([model, data]) => (data.isFallback === true ? `${model} (fallback)` : model));
}

function createEmptyModelUsage(): ModelUsage {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		costUSD: 0,
		isFallback: false,
	};
}

function addModelUsage(target: ModelUsage, usage: ModelUsage): void {
	target.inputTokens += usage.inputTokens;
	target.cachedInputTokens += usage.cachedInputTokens;
	target.outputTokens += usage.outputTokens;
	target.reasoningOutputTokens += usage.reasoningOutputTokens;
	target.totalTokens += usage.totalTokens;
	target.costUSD += usage.costUSD;
	if (usage.isFallback === true) {
		target.isFallback = true;
	}
}

export function calculateCodexReportTotals(rows: CodexReportRow[]): CodexReportTotals {
	const totals: CodexReportTotals = {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		costUSD: 0,
		models: {},
	};

	for (const row of rows) {
		totals.inputTokens += row.inputTokens;
		totals.cachedInputTokens += row.cachedInputTokens;
		totals.outputTokens += row.outputTokens;
		totals.reasoningOutputTokens += row.reasoningOutputTokens;
		totals.totalTokens += row.totalTokens;
		totals.costUSD += row.costUSD;

		for (const [modelName, usage] of Object.entries(row.models)) {
			const modelTotals = totals.models[modelName] ?? createEmptyModelUsage();
			if (totals.models[modelName] == null) {
				totals.models[modelName] = modelTotals;
			}
			addModelUsage(modelTotals, usage);
		}
	}

	return totals;
}

function formatModelUsageLabel(modelName: string, usage: ModelUsage): string {
	return usage.isFallback === true ? `${modelName} (fallback)` : modelName;
}

export function formatCodexModelBreakdownRows(
	models: Record<string, ModelUsage>,
	columns: CodexModelBreakdownColumns,
): (string | number)[][] {
	return sort(Object.entries(models))
		.desc(([, usage]) => usage.totalTokens)
		.map(([modelName, usage]) => {
			const split = splitUsageTokens(usage);
			const row = Array.from({ length: columns.totalColumns }, () => '');

			row[columns.labelColumn] = `  - ${formatModelUsageLabel(modelName, usage)}`;
			row[columns.inputColumn] = pc.gray(formatNumber(split.inputTokens));
			row[columns.outputColumn] = pc.gray(formatNumber(split.outputTokens));
			row[columns.reasoningColumn] = pc.gray(formatNumber(split.reasoningTokens));
			row[columns.cacheReadColumn] = pc.gray(formatNumber(split.cacheReadTokens));
			row[columns.totalTokensColumn] = pc.gray(formatNumber(usage.totalTokens));
			row[columns.costColumn] = pc.gray(formatCurrency(usage.costUSD));

			return row;
		});
}

export function pushCodexModelBreakdownRows(
	table: { push: (row: (string | number)[]) => void },
	models: Record<string, ModelUsage>,
	columns: CodexModelBreakdownColumns,
): void {
	for (const row of formatCodexModelBreakdownRows(models, columns)) {
		table.push(row);
	}
}

if (import.meta.vitest != null) {
	describe('calculateCodexReportTotals', () => {
		it('aggregates totals and per-model usage across report rows', () => {
			const totals = calculateCodexReportTotals([
				{
					inputTokens: 1_000,
					cachedInputTokens: 200,
					outputTokens: 500,
					reasoningOutputTokens: 100,
					totalTokens: 1_500,
					costUSD: 0.005,
					models: {
						'gpt-5': {
							inputTokens: 1_000,
							cachedInputTokens: 200,
							outputTokens: 500,
							reasoningOutputTokens: 100,
							totalTokens: 1_500,
							costUSD: 0.005,
						},
					},
				},
				{
					inputTokens: 400,
					cachedInputTokens: 100,
					outputTokens: 200,
					reasoningOutputTokens: 50,
					totalTokens: 600,
					costUSD: 0.001,
					models: {
						'gpt-5-mini': {
							inputTokens: 400,
							cachedInputTokens: 100,
							outputTokens: 200,
							reasoningOutputTokens: 50,
							totalTokens: 600,
							costUSD: 0.001,
						},
					},
				},
				{
					inputTokens: 200,
					cachedInputTokens: 0,
					outputTokens: 100,
					reasoningOutputTokens: 0,
					totalTokens: 300,
					costUSD: 0.002,
					models: {
						'gpt-5': {
							inputTokens: 200,
							cachedInputTokens: 0,
							outputTokens: 100,
							reasoningOutputTokens: 0,
							totalTokens: 300,
							costUSD: 0.002,
						},
					},
				},
			]);

			expect(totals).toMatchObject({
				inputTokens: 1_600,
				cachedInputTokens: 300,
				outputTokens: 800,
				reasoningOutputTokens: 150,
				totalTokens: 2_400,
				costUSD: 0.008,
			});
			expect(totals.models['gpt-5']).toMatchObject({
				inputTokens: 1_200,
				cachedInputTokens: 200,
				outputTokens: 600,
				reasoningOutputTokens: 100,
				totalTokens: 1_800,
				costUSD: 0.007,
			});
			expect(totals.models['gpt-5-mini']).toMatchObject({
				inputTokens: 400,
				cachedInputTokens: 100,
				outputTokens: 200,
				reasoningOutputTokens: 50,
				totalTokens: 600,
				costUSD: 0.001,
			});
		});
	});
}
