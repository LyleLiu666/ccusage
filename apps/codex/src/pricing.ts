import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import fs from 'node:fs/promises';

import { homedir } from 'node:os';
import path from 'node:path';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';

import { xdgCache } from 'xdg-basedir';
import { MILLION } from './_consts.ts';
import { prefetchCodexPricing } from './_macro.ts' with { type: 'macro' };
import { logger } from './logger.ts';

const CODEX_PROVIDER_PREFIXES = ['openai/', 'azure/', 'openrouter/openai/'];
const CODEX_MODEL_ALIASES_MAP = new Map<string, string>([['gpt-5-codex', 'gpt-5']]);

function toPerMillion(value: number | undefined, fallback?: number): number {
	const perToken = value ?? fallback ?? 0;
	return perToken * MILLION;
}

export type CodexPricingSourceOptions = {
	offline?: boolean;
	offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
};

const PREFETCHED_CODEX_PRICING = prefetchCodexPricing();

const FALLBACK_PRICING: Record<string, LiteLLMModelPricing> = {
	'gpt-5': {
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000015,
	},
	'gpt-5-codex': {
		input_cost_per_token: 0.000005,
		output_cost_per_token: 0.000015,
	},
	'gpt-4o': {
		input_cost_per_token: 0.0000025,
		output_cost_per_token: 0.00001,
	},
};

const INITIAL_PRICING =
	Object.keys(PREFETCHED_CODEX_PRICING).length > 0 ? PREFETCHED_CODEX_PRICING : FALLBACK_PRICING;

const CACHE_DIR = path.join(xdgCache ?? path.join(homedir(), '.cache'), 'ccusage');
const CACHE_FILE = path.join(CACHE_DIR, 'pricing.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function loadCache(): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		const stat = await fs.stat(CACHE_FILE);
		if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
			logger.debug('Pricing cache is stale');
			return await INITIAL_PRICING;
		}

		const content = await fs.readFile(CACHE_FILE, 'utf8');
		const data = JSON.parse(content) as Record<string, LiteLLMModelPricing>;
		logger.debug(`Loaded pricing from cache: ${CACHE_FILE}`);
		return data;
	} catch (error) {
		logger.debug('Failed to load pricing cache, using prefetch fallback', String(error));
		if (Object.keys(INITIAL_PRICING).length > 0) {
			logger.debug(`Using fallback pricing data (${Object.keys(INITIAL_PRICING).length} models)`);
		}
		return INITIAL_PRICING;
	}
}

async function saveCache(pricing: Record<string, LiteLLMModelPricing>): Promise<void> {
	try {
		await fs.mkdir(CACHE_DIR, { recursive: true });
		await fs.writeFile(CACHE_FILE, JSON.stringify(pricing), 'utf8');
		logger.debug(`Saved pricing to cache: ${CACHE_FILE}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.warn('Failed to save pricing cache', errorMessage);
	}
}

export class CodexPricingSource implements PricingSource, Disposable {
	private readonly fetcher: LiteLLMPricingFetcher;

	constructor(options: CodexPricingSourceOptions = {}) {
		this.fetcher = new LiteLLMPricingFetcher({
			offline: options.offline ?? false,
			// If offline is true, it overrides cacheStrategy to 'offline-only'
			cacheStrategy: 'network-first',
			offlineLoader: options.offlineLoader ?? loadCache,
			onCacheUpdate: saveCache,
			logger,
			providerPrefixes: CODEX_PROVIDER_PREFIXES,
		});
	}

	[Symbol.dispose](): void {
		this.fetcher[Symbol.dispose]();
	}

	async getPricing(model: string): Promise<ModelPricing> {
		const directLookup = await this.fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		let pricing = directLookup.value;
		if (pricing == null) {
			const alias = CODEX_MODEL_ALIASES_MAP.get(model);
			if (alias != null) {
				const aliasLookup = await this.fetcher.getModelPricing(alias);
				if (Result.isFailure(aliasLookup)) {
					throw aliasLookup.error;
				}
				pricing = aliasLookup.value;
			}
		}

		if (pricing == null) {
			throw new Error(`Pricing not found for model ${model}`);
		}

		return {
			inputCostPerMToken: toPerMillion(pricing.input_cost_per_token),
			cachedInputCostPerMToken: toPerMillion(
				pricing.cache_read_input_token_cost,
				pricing.input_cost_per_token,
			),
			outputCostPerMToken: toPerMillion(pricing.output_cost_per_token),
		};
	}
}

if (import.meta.vitest != null) {
	describe('CodexPricingSource', () => {
		it('converts LiteLLM pricing to per-million costs', async () => {
			using source = new CodexPricingSource({
				offline: true,
				offlineLoader: async () => ({
					'gpt-5': {
						input_cost_per_token: 1.25e-6,
						output_cost_per_token: 1e-5,
						cache_read_input_token_cost: 1.25e-7,
					},
				}),
			});

			const pricing = await source.getPricing('gpt-5-codex');
			expect(pricing.inputCostPerMToken).toBeCloseTo(1.25);
			expect(pricing.outputCostPerMToken).toBeCloseTo(10);
			expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.125);
		});

		it('refreshes stale cached pricing for newer versioned models', async () => {
			const originalFetch = globalThis.fetch;
			const fetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							'gpt-5.4': {
								input_cost_per_token: 2.5e-6,
								output_cost_per_token: 1.5e-5,
								cache_read_input_token_cost: 2.5e-7,
							},
							'gpt-5': {
								input_cost_per_token: 1.25e-6,
								output_cost_per_token: 1e-5,
								cache_read_input_token_cost: 1.25e-7,
							},
						}),
						{ status: 200 },
					),
			);

			vi.stubGlobal('fetch', fetchMock);

			try {
				using source = new CodexPricingSource({
					offlineLoader: async () => ({
						'gpt-5': {
							input_cost_per_token: 1.25e-6,
							output_cost_per_token: 1e-5,
							cache_read_input_token_cost: 1.25e-7,
						},
					}),
				});

				const pricing = await source.getPricing('gpt-5.4');

				expect(fetchMock).toHaveBeenCalledOnce();
				expect(pricing.inputCostPerMToken).toBeCloseTo(2.5);
				expect(pricing.outputCostPerMToken).toBeCloseTo(15);
				expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.25);
			} finally {
				vi.stubGlobal('fetch', originalFetch);
			}
		});
	});
}
