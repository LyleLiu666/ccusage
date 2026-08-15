import type { ModelPricing, TokenUsageDelta } from './_types.ts';
import { formatCurrency, formatTokens } from '@ccusage/internal/format';
import { MILLION } from './_consts.ts';

export function createEmptyUsage(): TokenUsageDelta {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	};
}

export function addUsage(target: TokenUsageDelta, delta: TokenUsageDelta): void {
	target.inputTokens += delta.inputTokens;
	target.cachedInputTokens += delta.cachedInputTokens;
	target.outputTokens += delta.outputTokens;
	target.reasoningOutputTokens += delta.reasoningOutputTokens;
	target.totalTokens += delta.totalTokens;
}

function nonCachedInputTokens(usage: TokenUsageDelta): number {
	const nonCached = usage.inputTokens - usage.cachedInputTokens;
	return nonCached > 0 ? nonCached : 0;
}

/**
 * Calculate the cost in USD for token usage based on model pricing
 *
 * @param usage - Token usage data including input, output, cached, and reasoning tokens
 * @param pricing - Model-specific pricing rates per million tokens
 * @returns Cost in USD
 *
 * @remarks
 * - Non-cached input is treated as cache creation when the pricing source exposes
 * a separate cache-write rate. Codex token_count logs do not expose a finer split.
 * - Cached input tokens use the model's cache-read rate.
 * @see {@link https://platform.openai.com/docs/guides/prompt-caching}
 *
 * - Reasoning tokens are already included in output_tokens, so they are not added separately
 * to avoid double-counting
 */
export function calculateCostUSD(usage: TokenUsageDelta, pricing: ModelPricing): number {
	const nonCachedInput = nonCachedInputTokens(usage);
	const cachedInput =
		usage.cachedInputTokens > usage.inputTokens ? usage.inputTokens : usage.cachedInputTokens;
	const outputTokens = usage.outputTokens;

	const cacheWriteRate = pricing.cacheWriteInputCostPerMToken ?? pricing.inputCostPerMToken;
	const inputCost = (nonCachedInput / MILLION) * cacheWriteRate;
	const cachedCost = (cachedInput / MILLION) * pricing.cachedInputCostPerMToken;
	const outputCost = (outputTokens / MILLION) * pricing.outputCostPerMToken;

	return inputCost + cachedCost + outputCost;
}

export { formatCurrency, formatTokens };

if (import.meta.vitest != null) {
	describe('calculateCostUSD', () => {
		it('charges non-cached GPT-5.6 input at the cache-write rate', () => {
			const cost = calculateCostUSD(
				{
					inputTokens: 1_000_000,
					cachedInputTokens: 600_000,
					outputTokens: 100_000,
					reasoningOutputTokens: 20_000,
					totalTokens: 1_100_000,
				},
				{
					inputCostPerMToken: 5,
					cacheWriteInputCostPerMToken: 6.25,
					cachedInputCostPerMToken: 0.5,
					outputCostPerMToken: 30,
				},
			);

			expect(cost).toBeCloseTo(5.8);
		});

		it('uses the ordinary input rate when cache-write pricing is unavailable', () => {
			const cost = calculateCostUSD(
				{
					inputTokens: 1_000_000,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
					totalTokens: 1_000_000,
				},
				{
					inputCostPerMToken: 5,
					cachedInputCostPerMToken: 0.5,
					outputCostPerMToken: 30,
				},
			);

			expect(cost).toBeCloseTo(5);
		});
	});
}
