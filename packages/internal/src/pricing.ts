import { Result } from '@praha/byethrow';
import * as v from 'valibot';

export const LITELLM_PRICING_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Default token threshold for tiered pricing in 1M context window models.
 * LiteLLM's pricing schema hard-codes this threshold in field names
 * (e.g., `input_cost_per_token_above_200k_tokens`).
 * The threshold parameter in calculateTieredCost allows flexibility for
 * future models that may use different thresholds.
 */
const DEFAULT_TIERED_THRESHOLD = 200_000;

/**
 * LiteLLM Model Pricing Schema
 *
 * ⚠️ TIERED PRICING NOTE:
 * Different models use different token thresholds for tiered pricing:
 * - Claude/Anthropic: 200k tokens (implemented in calculateTieredCost)
 * - Gemini: 128k tokens (schema fields only, NOT implemented in calculations)
 * - GPT/OpenAI: No tiered pricing (flat rate)
 *
 * When adding support for new models:
 * 1. Check if model has tiered pricing in LiteLLM data
 * 2. Verify the threshold value
 * 3. Update calculateTieredCost logic if threshold differs from 200k
 * 4. Add tests for tiered pricing boundaries
 */
export const liteLLMModelPricingSchema = v.object({
	input_cost_per_token: v.optional(v.number()),
	output_cost_per_token: v.optional(v.number()),
	cache_creation_input_token_cost: v.optional(v.number()),
	cache_read_input_token_cost: v.optional(v.number()),
	max_tokens: v.optional(v.number()),
	max_input_tokens: v.optional(v.number()),
	max_output_tokens: v.optional(v.number()),
	// Claude/Anthropic: 1M context window pricing (200k threshold)
	input_cost_per_token_above_200k_tokens: v.optional(v.number()),
	output_cost_per_token_above_200k_tokens: v.optional(v.number()),
	cache_creation_input_token_cost_above_200k_tokens: v.optional(v.number()),
	cache_read_input_token_cost_above_200k_tokens: v.optional(v.number()),
	// Gemini: Tiered pricing (128k threshold) - NOT implemented in calculations
	input_cost_per_token_above_128k_tokens: v.optional(v.number()),
	output_cost_per_token_above_128k_tokens: v.optional(v.number()),
});

export type LiteLLMModelPricing = v.InferOutput<typeof liteLLMModelPricingSchema>;

export type PricingLogger = {
	debug: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
};

export type LiteLLMPricingFetcherOptions = {
	logger?: PricingLogger;
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
	fetchTimeoutMs?: number;
	/**
	 * Strategy for loading pricing data.
	 *
	 * - `network-only`: Always fetch from network.
	 * - `network-first`: Try network first, fall back to offline loader if network fails.
	 * - `valid-cache-first`: Try offline loader first. If it returns data, use it. Otherwise (or if empty), fetch from network.
	 * - `offline-only`: Only use offline loader.
	 *
	 * @default 'network-first'
	 */
	cacheStrategy?: 'network-only' | 'valid-cache-first' | 'network-first' | 'offline-only';
	/**
	 * Callback invoked when new pricing data is successfully fetched from the network.
	 * This can be used to persist the data to a cache.
	 */
	onCacheUpdate?: (pricing: Record<string, LiteLLMModelPricing>) => Promise<void>;
	url?: string;
	providerPrefixes?: string[];
};

const DEFAULT_PROVIDER_PREFIXES = [
	'anthropic/',
	'claude-3-5-',
	'claude-3-',
	'claude-',
	'openai/',
	'azure/',
	'openrouter/openai/',
];

function createLogger(logger?: PricingLogger): PricingLogger {
	if (logger != null) {
		return logger;
	}

	return {
		debug: () => {},
		error: () => {},
		info: () => {},
		warn: () => {},
	};
}

export class LiteLLMPricingFetcher implements Disposable {
	private cachedPricing: Map<string, LiteLLMModelPricing> | null = null;
	private cachedPricingError: Error | null = null;
	private pricingLoadPromise: Promise<
		Result.Result<Map<string, LiteLLMModelPricing>, Error>
	> | null = null;
	private readonly logger: PricingLogger;
	private readonly offline: boolean;
	private readonly cacheStrategy:
		| 'network-only'
		| 'valid-cache-first'
		| 'network-first'
		| 'offline-only';
	private readonly offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
	private readonly onCacheUpdate?: (pricing: Record<string, LiteLLMModelPricing>) => Promise<void>;
	private readonly url: string;
	private readonly providerPrefixes: string[];
	private readonly fetchTimeoutMs: number;

	constructor(options: LiteLLMPricingFetcherOptions = {}) {
		this.logger = createLogger(options.logger);
		this.offline = Boolean(options.offline);
		// 'offline' option overrides cacheStrategy if set to true for backwards compatibility
		this.cacheStrategy = this.offline ? 'offline-only' : (options.cacheStrategy ?? 'network-first');
		this.offlineLoader = options.offlineLoader;
		this.onCacheUpdate = options.onCacheUpdate;
		this.url = options.url ?? LITELLM_PRICING_URL;
		this.providerPrefixes = options.providerPrefixes ?? DEFAULT_PROVIDER_PREFIXES;
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000;
	}

	[Symbol.dispose](): void {
		this.clearCache();
	}

	clearCache(): void {
		this.cachedPricing = null;
		this.cachedPricingError = null;
		this.pricingLoadPromise = null;
	}

	private loadOfflinePricing = Result.try({
		try: async () => {
			if (this.offlineLoader == null) {
				throw new Error('Offline loader was not provided');
			}

			const pricing = new Map(Object.entries(await this.offlineLoader()));
			this.cachedPricing = pricing;
			return pricing;
		},
		catch: (error) => new Error('Failed to load offline pricing data', { cause: error }),
	});

	private async handleFallbackToCachedPricing(
		originalError: unknown,
	): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		this.logger.warn(
			'Failed to fetch model pricing from LiteLLM, falling back to cached pricing data',
		);
		this.logger.debug('Fetch error details:', originalError);
		return Result.pipe(
			this.loadOfflinePricing(),
			Result.inspect((pricing) => {
				this.logger.info(`Using cached pricing data for ${pricing.size} models`);
			}),
			Result.inspectError((error) => {
				this.logger.error('Failed to load cached pricing data as fallback:', error);
				this.logger.error('Original fetch error:', originalError);
			}),
		);
	}

	private async fetchFromNetwork(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		this.logger.warn('Fetching latest model pricing from LiteLLM...');

		// Keep track of the raw data to pass to onCacheUpdate
		let rawData: Record<string, unknown> | null = null;

		return Result.pipe(
			Result.try({
				try: fetch(this.url, {
					signal: AbortSignal.timeout(this.fetchTimeoutMs),
				}),
				catch: (error) => new Error('Failed to fetch model pricing from LiteLLM', { cause: error }),
			}),
			Result.andThrough((response) => {
				if (!response.ok) {
					return Result.fail(new Error(`Failed to fetch pricing data: ${response.statusText}`));
				}
				return Result.succeed();
			}),
			Result.andThen(async (response) =>
				Result.try({
					try: response.json() as Promise<Record<string, unknown>>,
					catch: (error) => new Error('Failed to parse pricing data', { cause: error }),
				}),
			),
			// Store raw data and parse
			Result.map((data) => {
				rawData = data;
				const pricing = new Map<string, LiteLLMModelPricing>();
				for (const [modelName, modelData] of Object.entries(data)) {
					if (typeof modelData !== 'object' || modelData == null) {
						continue;
					}

					const parsed = v.safeParse(liteLLMModelPricingSchema, modelData);
					if (!parsed.success) {
						continue;
					}

					pricing.set(modelName, parsed.output);
				}
				return pricing;
			}),
			Result.inspect(async (pricing) => {
				this.cachedPricing = pricing;
				this.logger.info(`Loaded pricing for ${pricing.size} models`);

				// Save to cache if callback is provided
				if (this.onCacheUpdate != null && rawData != null) {
					try {
						// Filter rawData to only include valid items to save storage/bandwidth?
						// For now, let's just pass the validated items turned back into a record.
						// Actually, onCacheUpdate signature expects Record<string, LiteLLMModelPricing>
						const validData: Record<string, LiteLLMModelPricing> = {};
						for (const [key, value] of pricing) {
							validData[key] = value;
						}
						await this.onCacheUpdate(validData);
					} catch (error) {
						this.logger.warn('Failed to update pricing cache', error);
					}
				}
			}),
		);
	}

	private async ensurePricingLoaded(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		if (this.cachedPricing != null) {
			return Result.succeed(this.cachedPricing);
		}

		if (this.cachedPricingError != null) {
			return Result.fail(this.cachedPricingError);
		}

		if (this.pricingLoadPromise != null) {
			return this.pricingLoadPromise;
		}

		const loadPromise = (async () => {
			if (this.cacheStrategy === 'offline-only') {
				return this.loadOfflinePricing();
			}

			if (this.cacheStrategy === 'valid-cache-first') {
				const offlineResult = await this.loadOfflinePricing();
				if (Result.isSuccess(offlineResult) && offlineResult.value.size > 0) {
					this.logger.debug(
						`Using cached pricing data (${offlineResult.value.size} models) due to valid-cache-first strategy`,
					);
					return offlineResult;
				}
				// If offline fails or is empty, fall through to network fetch
				if (Result.isFailure(offlineResult)) {
					this.logger.debug(
						'Failed to load offline pricing for valid-cache-first strategy, falling back to network',
						offlineResult.error,
					);
				}
			}

			if (this.cacheStrategy === 'network-only') {
				// Skip offline fallback for network-only
				return this.fetchFromNetwork();
			}

			// network-first (default)
			return Result.pipe(
				await this.fetchFromNetwork(),
				Result.orElse(async (error) => this.handleFallbackToCachedPricing(error)),
			);
		})()
			.then((result) => {
				if (Result.isFailure(result)) {
					this.cachedPricingError = result.error;
					return result;
				}

				this.cachedPricing = result.value;
				return result;
			})
			.finally(() => {
				if (this.pricingLoadPromise === loadPromise) {
					this.pricingLoadPromise = null;
				}
			});

		this.pricingLoadPromise = loadPromise;
		return loadPromise;
	}

	async fetchModelPricing(): Result.ResultAsync<Map<string, LiteLLMModelPricing>, Error> {
		return this.ensurePricingLoaded();
	}

	private createMatchingCandidates(modelName: string): string[] {
		const candidates = new Set<string>();
		candidates.add(modelName);

		for (const prefix of this.providerPrefixes) {
			candidates.add(`${prefix}${modelName}`);
		}

		return Array.from(candidates);
	}

	async getModelPricing(modelName: string): Result.ResultAsync<LiteLLMModelPricing | null, Error> {
		return Result.pipe(
			this.ensurePricingLoaded(),
			Result.map((pricing) => {
				for (const candidate of this.createMatchingCandidates(modelName)) {
					const direct = pricing.get(candidate);
					if (direct != null) {
						return direct;
					}
				}

				const lower = modelName.toLowerCase();
				for (const [key, value] of pricing) {
					const comparison = key.toLowerCase();
					if (comparison.includes(lower) || lower.includes(comparison)) {
						return value;
					}
				}

				return null;
			}),
		);
	}

	async getModelContextLimit(modelName: string): Result.ResultAsync<number | null, Error> {
		return Result.pipe(
			this.getModelPricing(modelName),
			Result.map((pricing) => pricing?.max_input_tokens ?? null),
		);
	}

	/**
	 * Calculate the total cost for token usage based on model pricing
	 *
	 * Supports tiered pricing for 1M context window models where tokens
	 * above a threshold (default 200k) are charged at a different rate.
	 * Handles all token types: input, output, cache creation, and cache read.
	 *
	 * @param tokens - Token counts for different types
	 * @param tokens.input_tokens - Number of input tokens
	 * @param tokens.output_tokens - Number of output tokens
	 * @param tokens.cache_creation_input_tokens - Number of cache creation input tokens
	 * @param tokens.cache_read_input_tokens - Number of cache read input tokens
	 * @param pricing - Model pricing information from LiteLLM
	 * @returns Total cost in USD
	 */
	calculateCostFromPricing(
		tokens: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		},
		pricing: LiteLLMModelPricing,
	): number {
		/**
		 * Calculate cost with tiered pricing for 1M context window models
		 *
		 * @param totalTokens - Total number of tokens to calculate cost for
		 * @param basePrice - Price per token for tokens up to the threshold
		 * @param tieredPrice - Price per token for tokens above the threshold
		 * @param threshold - Token threshold for tiered pricing (default 200k)
		 * @returns Total cost applying tiered pricing when applicable
		 *
		 * @example
		 * // 300k tokens with base price $3/M and tiered price $6/M
		 * calculateTieredCost(300_000, 3e-6, 6e-6)
		 * // Returns: (200_000 * 3e-6) + (100_000 * 6e-6) = $1.2
		 */
		const calculateTieredCost = (
			totalTokens: number | undefined,
			basePrice: number | undefined,
			tieredPrice: number | undefined,
			threshold: number = DEFAULT_TIERED_THRESHOLD,
		): number => {
			if (totalTokens == null || totalTokens <= 0) {
				return 0;
			}

			if (totalTokens > threshold && tieredPrice != null) {
				const tokensBelowThreshold = Math.min(totalTokens, threshold);
				const tokensAboveThreshold = Math.max(0, totalTokens - threshold);

				let tieredCost = tokensAboveThreshold * tieredPrice;
				if (basePrice != null) {
					tieredCost += tokensBelowThreshold * basePrice;
				}
				return tieredCost;
			}

			if (basePrice != null) {
				return totalTokens * basePrice;
			}

			return 0;
		};

		const inputCost = calculateTieredCost(
			tokens.input_tokens,
			pricing.input_cost_per_token,
			pricing.input_cost_per_token_above_200k_tokens,
		);

		const outputCost = calculateTieredCost(
			tokens.output_tokens,
			pricing.output_cost_per_token,
			pricing.output_cost_per_token_above_200k_tokens,
		);

		const cacheCreationCost = calculateTieredCost(
			tokens.cache_creation_input_tokens,
			pricing.cache_creation_input_token_cost,
			pricing.cache_creation_input_token_cost_above_200k_tokens,
		);

		const cacheReadCost = calculateTieredCost(
			tokens.cache_read_input_tokens,
			pricing.cache_read_input_token_cost,
			pricing.cache_read_input_token_cost_above_200k_tokens,
		);

		return inputCost + outputCost + cacheCreationCost + cacheReadCost;
	}

	async calculateCostFromTokens(
		tokens: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		},
		modelName?: string,
	): Result.ResultAsync<number, Error> {
		if (modelName == null || modelName === '') {
			return Result.succeed(0);
		}

		return Result.pipe(
			this.getModelPricing(modelName),
			Result.andThen((pricing) => {
				if (pricing == null) {
					return Result.fail(new Error(`Model pricing not found for ${modelName}`));
				}
				return Result.succeed(this.calculateCostFromPricing(tokens, pricing));
			}),
		);
	}
}

if (import.meta.vitest != null) {
	describe('LiteLLMPricingFetcher', () => {
		it('deduplicates concurrent pricing loads', async () => {
			const originalFetch = globalThis.fetch;
			let fetchCount = 0;
			let releaseFetch: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				releaseFetch = resolve;
			});

			(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
				fetchCount++;
				await gate;
				return {
					ok: true,
					statusText: 'OK',
					json: async () => ({
						'gpt-5': {
							input_cost_per_token: 1e-6,
							output_cost_per_token: 2e-6,
						},
					}),
				} as unknown as Response;
			}) as unknown as typeof fetch;

			try {
				using fetcher = new LiteLLMPricingFetcher({
					url: 'https://example.invalid/model_prices_and_context_window.json',
				});

				const lookups = Array.from({ length: 50 }, async () => fetcher.getModelPricing('gpt-5'));

				// Let the concurrent calls enter fetch() before we release the stubbed response.
				await new Promise((resolve) => setTimeout(resolve, 0));
				releaseFetch?.();

				const results = await Promise.all(lookups);
				expect(fetchCount).toBe(1);
				for (const result of results) {
					expect(Result.isFailure(result)).toBe(false);
					if (Result.isSuccess(result)) {
						expect(result.value?.input_cost_per_token).toBe(1e-6);
					}
				}
			} finally {
				(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
			}
		});

		it('does not refetch pricing repeatedly after a load failure', async () => {
			const originalFetch = globalThis.fetch;
			let fetchCount = 0;

			(globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
				fetchCount++;
				throw new Error('network failure');
			}) as unknown as typeof fetch;

			try {
				using fetcher = new LiteLLMPricingFetcher({
					url: 'https://example.invalid/model_prices_and_context_window.json',
				});

				const first = await fetcher.getModelPricing('gpt-5');
				expect(Result.isFailure(first)).toBe(true);

				const second = await fetcher.getModelPricing('gpt-5');
				expect(Result.isFailure(second)).toBe(true);
				expect(fetchCount).toBe(1);
			} finally {
				(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
			}
		});

		it('returns pricing data from LiteLLM dataset', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBe(1);
		});

		it('passes an abort signal when a fetch timeout is configured', async () => {
			const originalFetch = globalThis.fetch;
			const fetchMock = vi.fn(
				async (_input: string | URL, _init?: RequestInit) =>
					new Response(
						JSON.stringify({
							'gpt-5': {
								input_cost_per_token: 1e-6,
								output_cost_per_token: 2e-6,
							},
						}),
						{ status: 200 },
					),
			);

			vi.stubGlobal('fetch', fetchMock);

			try {
				using fetcher = new LiteLLMPricingFetcher({
					cacheStrategy: 'network-only',
					fetchTimeoutMs: 1_234,
					url: 'https://example.invalid/model_prices_and_context_window.json',
				});

				const pricing = await fetcher.getModelPricing('gpt-5');
				expect(Result.isSuccess(pricing)).toBe(true);
				expect(fetchMock).toHaveBeenCalledOnce();
				expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
			} finally {
				vi.stubGlobal('fetch', originalFetch);
			}
		});

		it('calculates cost using pricing information', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const cost = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 1000,
						output_tokens: 500,
						cache_read_input_tokens: 200,
					},
					'gpt-5',
				),
			);

			expect(cost).toBeCloseTo(1000 * 1.25e-6 + 500 * 1e-5 + 200 * 1.25e-7);
		});

		it('calculates tiered pricing for tokens exceeding 200k threshold (300k input, 250k output, 300k cache creation, 250k cache read)', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'anthropic/claude-4-sonnet-20250514': {
						input_cost_per_token: 3e-6,
						output_cost_per_token: 1.5e-5,
						input_cost_per_token_above_200k_tokens: 6e-6,
						output_cost_per_token_above_200k_tokens: 2.25e-5,
						cache_creation_input_token_cost: 3.75e-6,
						cache_read_input_token_cost: 3e-7,
						cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
						cache_read_input_token_cost_above_200k_tokens: 6e-7,
					},
				}),
			});

			// Test comprehensive scenario with all token types above 200k threshold
			const cost = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 300_000,
						output_tokens: 250_000,
						cache_creation_input_tokens: 300_000,
						cache_read_input_tokens: 250_000,
					},
					'anthropic/claude-4-sonnet-20250514',
				),
			);

			const expectedCost =
				200_000 * 3e-6 +
				100_000 * 6e-6 + // input
				200_000 * 1.5e-5 +
				50_000 * 2.25e-5 + // output
				200_000 * 3.75e-6 +
				100_000 * 7.5e-6 + // cache creation
				200_000 * 3e-7 +
				50_000 * 6e-7; // cache read
			expect(cost).toBeCloseTo(expectedCost);
		});

		it('uses standard pricing for 300k/250k tokens when model lacks tiered pricing', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
					},
				}),
			});

			// Should use normal pricing for all tokens
			const cost = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 300_000,
						output_tokens: 250_000,
					},
					'gpt-5',
				),
			);

			expect(cost).toBeCloseTo(300_000 * 1e-6 + 250_000 * 2e-6);
		});

		it('correctly applies pricing at 200k boundary (200k uses base, 200,001 uses tiered, 0 returns 0)', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'claude-4-sonnet-20250514': {
						input_cost_per_token: 3e-6,
						input_cost_per_token_above_200k_tokens: 6e-6,
					},
				}),
			});

			// Test with exactly 200k tokens (should use only base price)
			const cost200k = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 200_000,
						output_tokens: 0,
					},
					'claude-4-sonnet-20250514',
				),
			);
			expect(cost200k).toBeCloseTo(200_000 * 3e-6);

			// Test with 200,001 tokens (should use tiered pricing for 1 token)
			const cost200k1 = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 200_001,
						output_tokens: 0,
					},
					'claude-4-sonnet-20250514',
				),
			);
			expect(cost200k1).toBeCloseTo(200_000 * 3e-6 + 1 * 6e-6);

			// Test with 0 tokens (should return 0)
			const costZero = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 0,
						output_tokens: 0,
					},
					'claude-4-sonnet-20250514',
				),
			);
			expect(costZero).toBe(0);
		});

		it('charges only for tokens above 200k when base price is missing (300k→100k charged, 100k→0 charged)', async () => {
			using fetcher = new LiteLLMPricingFetcher({
				offline: true,
				offlineLoader: async () => ({
					'theoretical-model': {
						// No base price, only tiered pricing
						input_cost_per_token_above_200k_tokens: 6e-6,
						output_cost_per_token_above_200k_tokens: 2.25e-5,
					},
				}),
			});

			// Test with 300k tokens - should only charge for tokens above 200k
			const cost = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 300_000,
						output_tokens: 250_000,
					},
					'theoretical-model',
				),
			);

			// Only 100k input tokens above 200k are charged
			// Only 50k output tokens above 200k are charged
			expect(cost).toBeCloseTo(100_000 * 6e-6 + 50_000 * 2.25e-5);

			// Test with tokens below threshold - should return 0 (no base price)
			const costBelow = await Result.unwrap(
				fetcher.calculateCostFromTokens(
					{
						input_tokens: 100_000,
						output_tokens: 100_000,
					},
					'theoretical-model',
				),
			);
			expect(costBelow).toBe(0);
		});
	});
}
