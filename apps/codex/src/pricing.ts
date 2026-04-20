import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { ModelPricing, PricingSource } from './_types.ts';
import fs from 'node:fs/promises';

import { homedir } from 'node:os';
import path from 'node:path';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';

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
	cacheFile?: string;
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

type PricingCacheState = 'fresh' | 'stale' | 'missing';

async function getPricingCacheState(cacheFile: string): Promise<PricingCacheState> {
	try {
		const cacheStat = await fs.stat(cacheFile);
		return Date.now() - cacheStat.mtimeMs > CACHE_TTL_MS ? 'stale' : 'fresh';
	} catch (error) {
		logger.debug('Failed to inspect pricing cache, treating as missing', String(error));
		return 'missing';
	}
}

async function readCacheFile(cacheFile: string): Promise<Record<string, LiteLLMModelPricing>> {
	const content = await fs.readFile(cacheFile, 'utf8');
	const data = JSON.parse(content) as Record<string, LiteLLMModelPricing>;
	logger.debug(`Loaded pricing from cache: ${cacheFile}`);
	return data;
}

async function loadCache(cacheFile: string): Promise<Record<string, LiteLLMModelPricing>> {
	try {
		return await readCacheFile(cacheFile);
	} catch (error) {
		logger.debug('Failed to load pricing cache, using prefetch fallback', String(error));
		if (Object.keys(INITIAL_PRICING).length > 0) {
			logger.debug(`Using fallback pricing data (${Object.keys(INITIAL_PRICING).length} models)`);
		}
		return INITIAL_PRICING;
	}
}

async function saveCache(
	pricing: Record<string, LiteLLMModelPricing>,
	cacheFile: string,
): Promise<void> {
	try {
		await fs.mkdir(path.dirname(cacheFile), { recursive: true });
		await fs.writeFile(cacheFile, JSON.stringify(pricing), 'utf8');
		logger.debug(`Saved pricing to cache: ${cacheFile}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.warn('Failed to save pricing cache', errorMessage);
	}
}

export class CodexPricingSource implements PricingSource, Disposable {
	private readonly cacheFile: string;
	private readonly offline: boolean;
	private readonly offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
	private fetcher: LiteLLMPricingFetcher | null = null;
	private fetcherPromise: Promise<LiteLLMPricingFetcher> | null = null;
	private fetcherCacheStrategy: 'offline-only' | 'valid-cache-first' | 'network-first' | null =
		null;

	constructor(options: CodexPricingSourceOptions = {}) {
		this.cacheFile = options.cacheFile ?? CACHE_FILE;
		this.offline = options.offline ?? false;
		this.offlineLoader = options.offlineLoader;
	}

	[Symbol.dispose](): void {
		this.fetcher?.[Symbol.dispose]();
		this.fetcher = null;
		this.fetcherPromise = null;
		this.fetcherCacheStrategy = null;
	}

	private getOfflineLoader(): () => Promise<Record<string, LiteLLMModelPricing>> {
		return (
			this.offlineLoader ??
			(async () => {
				return loadCache(this.cacheFile);
			})
		);
	}

	private createFetcher(
		cacheStrategy: 'offline-only' | 'valid-cache-first' | 'network-first',
	): LiteLLMPricingFetcher {
		return new LiteLLMPricingFetcher({
			offline: this.offline,
			cacheStrategy,
			offlineLoader: this.getOfflineLoader(),
			onCacheUpdate: async (pricing) => saveCache(pricing, this.cacheFile),
			logger,
			providerPrefixes: CODEX_PROVIDER_PREFIXES,
			fetchTimeoutMs: 10_000,
		});
	}

	private createLookupCandidates(model: string): string[] {
		const candidates = new Set<string>([model]);
		for (const prefix of CODEX_PROVIDER_PREFIXES) {
			candidates.add(`${prefix}${model}`);
		}

		const alias = CODEX_MODEL_ALIASES_MAP.get(model);
		if (alias != null) {
			candidates.add(alias);
			for (const prefix of CODEX_PROVIDER_PREFIXES) {
				candidates.add(`${prefix}${alias}`);
			}
		}

		return Array.from(candidates);
	}

	private async hasExplicitPricingEntry(
		fetcher: LiteLLMPricingFetcher,
		model: string,
	): Promise<boolean> {
		const pricingDataset = await fetcher.fetchModelPricing();
		if (Result.isFailure(pricingDataset)) {
			throw pricingDataset.error;
		}

		for (const candidate of this.createLookupCandidates(model)) {
			if (pricingDataset.value.has(candidate)) {
				return true;
			}
		}

		return false;
	}

	private async lookupPricing(
		fetcher: LiteLLMPricingFetcher,
		model: string,
	): Promise<LiteLLMModelPricing | null> {
		const directLookup = await fetcher.getModelPricing(model);
		if (Result.isFailure(directLookup)) {
			throw directLookup.error;
		}

		let pricing = directLookup.value;
		if (pricing == null) {
			const alias = CODEX_MODEL_ALIASES_MAP.get(model);
			if (alias != null) {
				const aliasLookup = await fetcher.getModelPricing(alias);
				if (Result.isFailure(aliasLookup)) {
					throw aliasLookup.error;
				}
				pricing = aliasLookup.value;
			}
		}

		return pricing;
	}

	private async refreshFetcherFromNetwork(): Promise<LiteLLMPricingFetcher> {
		if (this.offline) {
			return this.getFetcher();
		}

		this.fetcher?.[Symbol.dispose]();
		this.fetcher = null;
		this.fetcherPromise = null;
		this.fetcherCacheStrategy = 'network-first';

		const fetcher = this.createFetcher('network-first');
		this.fetcher = fetcher;
		return fetcher;
	}

	private async getFetcher(): Promise<LiteLLMPricingFetcher> {
		if (this.fetcher != null) {
			return this.fetcher;
		}

		if (this.fetcherPromise != null) {
			return this.fetcherPromise;
		}

		const pendingFetcher = (async () => {
			const cacheState = this.offline ? 'fresh' : await getPricingCacheState(this.cacheFile);
			const cacheStrategy = this.offline
				? 'offline-only'
				: cacheState === 'fresh'
					? 'valid-cache-first'
					: 'network-first';
			const fetcher = this.createFetcher(cacheStrategy);

			this.fetcher = fetcher;
			this.fetcherCacheStrategy = cacheStrategy;
			return fetcher;
		})().finally(() => {
			if (this.fetcherPromise === pendingFetcher) {
				this.fetcherPromise = null;
			}
		});

		this.fetcherPromise = pendingFetcher;
		return pendingFetcher;
	}

	async getPricing(model: string): Promise<ModelPricing> {
		let fetcher = await this.getFetcher();
		let pricing = await this.lookupPricing(fetcher, model);

		if (
			!this.offline &&
			this.fetcherCacheStrategy === 'valid-cache-first' &&
			!(await this.hasExplicitPricingEntry(fetcher, model))
		) {
			fetcher = await this.refreshFetcherFromNetwork();
			pricing = await this.lookupPricing(fetcher, model);
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

		it('uses a fresh cache before hitting the network', async () => {
			const originalFetch = globalThis.fetch;
			const fetchMock = vi.fn(async () => {
				throw new Error('network should not be used when cache is fresh');
			});

			vi.stubGlobal('fetch', fetchMock);

			await using fixture = await createFixture({
				cache: {
					'pricing.json': JSON.stringify({
						'gpt-5': {
							input_cost_per_token: 1.25e-6,
							output_cost_per_token: 1e-5,
							cache_read_input_token_cost: 1.25e-7,
						},
					}),
				},
			});

			try {
				using source = new CodexPricingSource({
					cacheFile: fixture.getPath('cache/pricing.json'),
				});

				const pricing = await source.getPricing('gpt-5');
				expect(fetchMock).not.toHaveBeenCalled();
				expect(pricing.inputCostPerMToken).toBeCloseTo(1.25);
				expect(pricing.outputCostPerMToken).toBeCloseTo(10);
				expect(pricing.cachedInputCostPerMToken).toBeCloseTo(0.125);
			} finally {
				vi.stubGlobal('fetch', originalFetch);
			}
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
			await using fixture = await createFixture({
				cache: {
					'pricing.json': JSON.stringify({
						'gpt-5': {
							input_cost_per_token: 1.25e-6,
							output_cost_per_token: 1e-5,
							cache_read_input_token_cost: 1.25e-7,
						},
					}),
				},
			});
			const staleTimestamp = new Date(Date.now() - CACHE_TTL_MS - 1_000);
			await fs.utimes(fixture.getPath('cache/pricing.json'), staleTimestamp, staleTimestamp);

			try {
				using source = new CodexPricingSource({
					cacheFile: fixture.getPath('cache/pricing.json'),
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

		it('refreshes from the network when a fresh cache misses the requested model', async () => {
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
			await using fixture = await createFixture({
				cache: {
					'pricing.json': JSON.stringify({
						'gpt-5': {
							input_cost_per_token: 1.25e-6,
							output_cost_per_token: 1e-5,
							cache_read_input_token_cost: 1.25e-7,
						},
					}),
				},
			});

			try {
				using source = new CodexPricingSource({
					cacheFile: fixture.getPath('cache/pricing.json'),
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
