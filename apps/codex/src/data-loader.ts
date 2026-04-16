import type { TokenUsageDelta, TokenUsageEvent } from './_types.ts';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	CODEX_HOME_ENV,
	DEFAULT_CODEX_DIR,
	DEFAULT_SESSION_SUBDIR,
	SESSION_GLOB,
} from './_consts.ts';
import { logger } from './logger.ts';

type RawUsage = {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
};

function ensureNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Normalize Codex `token_count` payloads into a predictable shape.
 *
 * Codex reports four counters:
 *   - input_tokens
 *   - cached_input_tokens (a.k.a cache_read_input_tokens)
 *   - output_tokens (this already includes any reasoning charge)
 *   - reasoning_output_tokens (informational only)
 *
 * Modern JSONL entries also provide `total_tokens`, but legacy ones may omit it.
 * When that happens we mirror Codex' billing behavior and synthesize
 * `input + output` (reasoning is treated as part of output, not an extra charge).
 */
function normalizeRawUsage(value: unknown): RawUsage | null {
	if (value == null || typeof value !== 'object') {
		return null;
	}

	const record = value as Record<string, unknown>;
	const input = ensureNumber(record.input_tokens);
	const cached = ensureNumber(record.cached_input_tokens ?? record.cache_read_input_tokens);
	const output = ensureNumber(record.output_tokens);
	const reasoning = ensureNumber(record.reasoning_output_tokens);
	const total = ensureNumber(record.total_tokens);

	return {
		input_tokens: input,
		cached_input_tokens: cached,
		output_tokens: output,
		reasoning_output_tokens: reasoning,
		// LiteLLM pricing treats reasoning tokens as part of the normal output price. Codex
		// includes them as a separate field but does not add them to total_tokens, so when we
		// have to synthesize a total (legacy logs), we mirror that behavior with input+output.
		total_tokens: total > 0 ? total : input + output,
	};
}

function subtractRawUsage(current: RawUsage, previous: RawUsage | null): RawUsage {
	return {
		input_tokens: Math.max(current.input_tokens - (previous?.input_tokens ?? 0), 0),
		cached_input_tokens: Math.max(
			current.cached_input_tokens - (previous?.cached_input_tokens ?? 0),
			0,
		),
		output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
		reasoning_output_tokens: Math.max(
			current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0),
			0,
		),
		total_tokens: Math.max(current.total_tokens - (previous?.total_tokens ?? 0), 0),
	};
}

/**
 * Convert cumulative usage into a per-event delta.
 *
 * Codex includes the cost of reasoning inside `output_tokens`. The
 * `reasoning_output_tokens` field is useful for display/debug purposes, but we
 * must not add it to the billable output again. For legacy totals we therefore
 * fallback to `input + output`.
 */
function convertToDelta(raw: RawUsage): TokenUsageDelta {
	const total = raw.total_tokens > 0 ? raw.total_tokens : raw.input_tokens + raw.output_tokens;

	const cached = Math.min(raw.cached_input_tokens, raw.input_tokens);

	return {
		inputTokens: raw.input_tokens,
		cachedInputTokens: cached,
		outputTokens: raw.output_tokens,
		reasoningOutputTokens: raw.reasoning_output_tokens,
		totalTokens: total,
	};
}

const recordSchema = v.record(v.string(), v.unknown());
const LEGACY_FALLBACK_MODEL = 'gpt-5';

const entrySchema = v.object({
	type: v.string(),
	payload: v.optional(v.unknown()),
	timestamp: v.optional(v.string()),
});

const tokenCountPayloadSchema = v.object({
	type: v.literal('token_count'),
	info: v.optional(recordSchema),
});

const FORK_REPLAY_GAP_MS = 1_000;
const FORK_REPLAY_MAX_BURST_SPAN_MS = 1_000;
const FORK_REPLAY_MIN_UNIQUE_TIMESTAMPS = 20;
const FORK_REPLAY_MIN_TOKEN_EVENTS = 20;

function getForkReplayCutoffLine(lines: string[]): number | null {
	let isForkedSession = false;
	let foundFirstEntry = false;
	let forkedSessionId: string | undefined;
	let sawParentSessionMeta = false;
	let firstUniqueTimestampMs: number | undefined;
	let previousUniqueTimestamp: string | undefined;
	let previousUniqueTimestampMs: number | undefined;
	let uniqueTimestampCount = 0;
	let tokenEventCount = 0;

	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (trimmed === '') {
			continue;
		}

		const parseLine = Result.try({
			try: () => JSON.parse(trimmed) as unknown,
			catch: (error) => error,
		});
		const parsedResult = parseLine();
		if (Result.isFailure(parsedResult)) {
			continue;
		}

		const entryParse = v.safeParse(entrySchema, parsedResult.value);
		if (!entryParse.success) {
			continue;
		}

		const entry = entryParse.output;
		if (!foundFirstEntry) {
			foundFirstEntry = true;
			if (entry.type !== 'session_meta') {
				return null;
			}

			const sessionMeta = v.safeParse(recordSchema, entry.payload ?? null);
			if (!sessionMeta.success) {
				return null;
			}

			forkedSessionId = asNonEmptyString(sessionMeta.output.id);
			isForkedSession = asNonEmptyString(sessionMeta.output.forked_from_id) != null;
			if (!isForkedSession) {
				return null;
			}
		} else if (entry.type === 'session_meta') {
			const sessionMeta = v.safeParse(recordSchema, entry.payload ?? null);
			if (sessionMeta.success) {
				const sessionId = asNonEmptyString(sessionMeta.output.id);
				if (sessionId != null && sessionId !== forkedSessionId) {
					sawParentSessionMeta = true;
				}
			}
		}

		const timestamp = entry.timestamp;
		if (timestamp == null || timestamp === previousUniqueTimestamp) {
			const tokenPayloadResult = v.safeParse(tokenCountPayloadSchema, entry.payload ?? undefined);
			if (tokenPayloadResult.success) {
				tokenEventCount += 1;
			}
			continue;
		}

		const timestampMs = Date.parse(timestamp);
		if (Number.isNaN(timestampMs)) {
			continue;
		}

		if (
			previousUniqueTimestampMs != null &&
			timestampMs - previousUniqueTimestampMs >= FORK_REPLAY_GAP_MS
		) {
			const replaySpanMs = (previousUniqueTimestampMs ?? timestampMs) - (firstUniqueTimestampMs ?? timestampMs);
			if (
				sawParentSessionMeta &&
				uniqueTimestampCount >= FORK_REPLAY_MIN_UNIQUE_TIMESTAMPS &&
				tokenEventCount >= FORK_REPLAY_MIN_TOKEN_EVENTS &&
				replaySpanMs <= FORK_REPLAY_MAX_BURST_SPAN_MS
			) {
				return index;
			}
			return null;
		}

		const tokenPayloadResult = v.safeParse(tokenCountPayloadSchema, entry.payload ?? undefined);
		if (tokenPayloadResult.success) {
			tokenEventCount += 1;
		}

		firstUniqueTimestampMs ??= timestampMs;
		previousUniqueTimestamp = timestamp;
		previousUniqueTimestampMs = timestampMs;
		uniqueTimestampCount += 1;
	}

	return null;
}

function extractModel(value: unknown): string | undefined {
	const parsed = v.safeParse(recordSchema, value);
	if (!parsed.success) {
		return undefined;
	}

	const payload = parsed.output;

	const infoCandidate = payload.info;
	if (infoCandidate != null) {
		const infoParsed = v.safeParse(recordSchema, infoCandidate);
		if (infoParsed.success) {
			const info = infoParsed.output;
			const directCandidates = [info.model, info.model_name];
			for (const candidate of directCandidates) {
				const model = asNonEmptyString(candidate);
				if (model != null) {
					return model;
				}
			}

			if (info.metadata != null) {
				const metadataParsed = v.safeParse(recordSchema, info.metadata);
				if (metadataParsed.success) {
					const model = asNonEmptyString(metadataParsed.output.model);
					if (model != null) {
						return model;
					}
				}
			}
		}
	}

	const fallbackModel = asNonEmptyString(payload.model);
	if (fallbackModel != null) {
		return fallbackModel;
	}

	if (payload.metadata != null) {
		const metadataParsed = v.safeParse(recordSchema, payload.metadata);
		if (metadataParsed.success) {
			const model = asNonEmptyString(metadataParsed.output.model);
			if (model != null) {
				return model;
			}
		}
	}

	return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

export type LoadOptions = {
	sessionDirs?: string[];
	/** Skip files with modification time before this timestamp (ms since epoch) */
	sinceTimestamp?: number;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectories: string[];
};

export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const providedDirs =
		options.sessionDirs != null && options.sessionDirs.length > 0
			? options.sessionDirs.map((dir) => path.resolve(dir))
			: undefined;

	const codexHomeEnv = process.env[CODEX_HOME_ENV]?.trim();
	const codexHome =
		codexHomeEnv != null && codexHomeEnv !== '' ? path.resolve(codexHomeEnv) : DEFAULT_CODEX_DIR;
	const defaultSessionsDir = path.join(codexHome, DEFAULT_SESSION_SUBDIR);
	const sessionDirs = providedDirs ?? [defaultSessionsDir];

	const events: TokenUsageEvent[] = [];
	const missingDirectories: string[] = [];

	for (const dir of sessionDirs) {
		const directoryPath = path.resolve(dir);
		const statResult = await Result.try({
			try: stat(directoryPath),
			catch: (error) => error,
		});

		if (Result.isFailure(statResult)) {
			missingDirectories.push(directoryPath);
			continue;
		}

		if (!statResult.value.isDirectory()) {
			missingDirectories.push(directoryPath);
			continue;
		}

		const files = await glob(SESSION_GLOB, {
			cwd: directoryPath,
			absolute: true,
		});

		for (const file of files) {
			// Skip files older than sinceTimestamp based on file modification time
			if (options.sinceTimestamp != null) {
				const fileStatResult = await Result.try({
					try: stat(file),
					catch: (error) => error,
				});
				if (Result.isSuccess(fileStatResult)) {
					const mtime = fileStatResult.value.mtime.getTime();
					if (mtime < options.sinceTimestamp) {
						continue;
					}
				}
			}

			const relativeSessionPath = path.relative(directoryPath, file);
			const normalizedSessionPath = relativeSessionPath.split(path.sep).join('/');
			const sessionId = normalizedSessionPath.replace(/\.jsonl$/i, '');
			const fileContentResult = await Result.try({
				try: readFile(file, 'utf8'),
				catch: (error) => error,
			});

			if (Result.isFailure(fileContentResult)) {
				logger.debug('Failed to read Codex session file', fileContentResult.error);
				continue;
			}

			let previousTotals: RawUsage | null = null;
			let currentModel: string | undefined;
			let currentModelIsFallback = false;
			let legacyFallbackUsed = false;
			const lines = fileContentResult.value.split(/\r?\n/);
			const forkReplayCutoffLine = getForkReplayCutoffLine(lines);
			for (const [index, line] of lines.entries()) {
				const trimmed = line.trim();
				if (trimmed === '') {
					continue;
				}

				const parseLine = Result.try({
					try: () => JSON.parse(trimmed) as unknown,
					catch: (error) => error,
				});
				const parsedResult = parseLine();

				if (Result.isFailure(parsedResult)) {
					continue;
				}

				const entryParse = v.safeParse(entrySchema, parsedResult.value);
				if (!entryParse.success) {
					continue;
				}

				const { type: entryType, payload, timestamp } = entryParse.output;

				if (entryType === 'turn_context') {
					const contextPayload = v.safeParse(recordSchema, payload ?? null);
					if (contextPayload.success) {
						const contextModel = extractModel(contextPayload.output);
						if (contextModel != null) {
							currentModel = contextModel;
							currentModelIsFallback = false;
						}
					}
					continue;
				}

				if (entryType !== 'event_msg') {
					continue;
				}

				const tokenPayloadResult = v.safeParse(tokenCountPayloadSchema, payload ?? undefined);
				if (!tokenPayloadResult.success) {
					continue;
				}

				if (timestamp == null) {
					continue;
				}

				const info = tokenPayloadResult.output.info;
				const lastUsage = normalizeRawUsage(info?.last_token_usage);
				const totalUsage = normalizeRawUsage(info?.total_token_usage);

				let raw = lastUsage;
				if (raw == null && totalUsage != null) {
					raw = subtractRawUsage(totalUsage, previousTotals);
				}

				if (totalUsage != null) {
					previousTotals = totalUsage;
				}

				if (raw == null) {
					continue;
				}

				if (forkReplayCutoffLine != null && index < forkReplayCutoffLine) {
					continue;
				}

				const delta = convertToDelta(raw);
				if (
					delta.inputTokens === 0 &&
					delta.cachedInputTokens === 0 &&
					delta.outputTokens === 0 &&
					delta.reasoningOutputTokens === 0
				) {
					continue;
				}

				const payloadRecordResult = v.safeParse(recordSchema, payload ?? undefined);
				const extractionSource = payloadRecordResult.success
					? Object.assign({}, payloadRecordResult.output, { info })
					: { info };
				const extractedModel = extractModel(extractionSource);
				let isFallbackModel = false;
				if (extractedModel != null) {
					currentModel = extractedModel;
					currentModelIsFallback = false;
				}

				let model = extractedModel ?? currentModel;
				if (model == null) {
					model = LEGACY_FALLBACK_MODEL;
					isFallbackModel = true;
					legacyFallbackUsed = true;
					currentModel = model;
					currentModelIsFallback = true;
				} else if (extractedModel == null && currentModelIsFallback) {
					isFallbackModel = true;
				}

				const event: TokenUsageEvent = {
					sessionId,
					timestamp,
					model,
					inputTokens: delta.inputTokens,
					cachedInputTokens: delta.cachedInputTokens,
					outputTokens: delta.outputTokens,
					reasoningOutputTokens: delta.reasoningOutputTokens,
					totalTokens: delta.totalTokens,
				};

				if (isFallbackModel) {
					// Surface the fallback so both table + JSON outputs can annotate pricing that was
					// inferred rather than sourced from the log metadata.
					event.isFallbackModel = true;
				}

				events.push(event);
			}

			if (legacyFallbackUsed) {
				logger.debug('Legacy Codex session lacked model metadata; applied fallback', {
					file,
					model: LEGACY_FALLBACK_MODEL,
				});
			}
		}
	}

	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return { events, missingDirectories };
}

if (import.meta.vitest != null) {
	describe('loadTokenUsageEvents', () => {
		const buildReplayTokenLines = (options: {
			baseTimestamp: string;
			count: number;
			startInput: number;
			startCachedInput: number;
			startOutput: number;
			model: string;
		}): string[] =>
			Array.from({ length: options.count }, (_, index) => {
				const cumulativeInput = options.startInput + index * 10;
				const cumulativeCachedInput = options.startCachedInput + index * 2;
				const cumulativeOutput = options.startOutput + index * 5;
				const cumulativeTotal = cumulativeInput + cumulativeOutput;
				const lastInput = index === 0 ? options.startInput : 10;
				const lastCachedInput = index === 0 ? options.startCachedInput : 2;
				const lastOutput = index === 0 ? options.startOutput : 5;
				const lastTotal = index === 0 ? options.startInput + options.startOutput : 15;

				return JSON.stringify({
					timestamp: `${options.baseTimestamp}${String(index + 2).padStart(3, '0')}Z`,
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: cumulativeInput,
								cached_input_tokens: cumulativeCachedInput,
								output_tokens: cumulativeOutput,
								reasoning_output_tokens: 0,
								total_tokens: cumulativeTotal,
							},
							last_token_usage: {
								input_tokens: lastInput,
								cached_input_tokens: lastCachedInput,
								output_tokens: lastOutput,
								reasoning_output_tokens: 0,
								total_tokens: lastTotal,
							},
							model: options.model,
						},
					},
				});
			});

		it('parses token_count events and skips entries without model metadata', async () => {
			await using fixture = await createFixture({
				sessions: {
					'project-1.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-11T18:25:30.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-11T18:25:40.670Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 1_200,
										cached_input_tokens: 200,
										output_tokens: 500,
										reasoning_output_tokens: 0,
										total_tokens: 1_700,
									},
									last_token_usage: {
										input_tokens: 1_200,
										cached_input_tokens: 200,
										output_tokens: 500,
										reasoning_output_tokens: 0,
										total_tokens: 1_700,
									},
									model: 'gpt-5',
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-11T18:40:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-12T00:00:00.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 2_000,
										cached_input_tokens: 300,
										output_tokens: 800,
										reasoning_output_tokens: 0,
										total_tokens: 2_800,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			expect(await fixture.exists('sessions/project-1.jsonl')).toBe(true);

			const { events, missingDirectories } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});
			expect(missingDirectories).toEqual([]);

			expect(events).toHaveLength(2);
			const first = events[0]!;
			expect(first.model).toBe('gpt-5');
			expect(first.inputTokens).toBe(1_200);
			expect(first.cachedInputTokens).toBe(200);
			const second = events[1]!;
			expect(second.model).toBe('gpt-5');
			expect(second.inputTokens).toBe(800);
			expect(second.cachedInputTokens).toBe(100);
		});

		it('falls back to legacy model when metadata is missing entirely', async () => {
			await using fixture = await createFixture({
				sessions: {
					'legacy.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-15T13:00:00.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 5_000,
										cached_input_tokens: 0,
										output_tokens: 1_000,
										reasoning_output_tokens: 0,
										total_tokens: 6_000,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});
			expect(events).toHaveLength(1);
			expect(events[0]!.model).toBe('gpt-5');
			expect(events[0]!.isFallbackModel).toBe(true);
		});

		it('skips replayed fork history but keeps new token deltas after the replay cutover', async () => {
			const replayLines = buildReplayTokenLines({
				baseTimestamp: '2025-09-16T10:00:00.',
				count: 25,
				startInput: 1_000,
				startCachedInput: 100,
				startOutput: 400,
				model: 'gpt-5',
			});
			const replayTailInput = 1_000 + (replayLines.length - 1) * 10;
			const replayTailCachedInput = 100 + (replayLines.length - 1) * 2;
			const replayTailOutput = 400 + (replayLines.length - 1) * 5;

			await using fixture = await createFixture({
				sessions: {
					'forked.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-16T10:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'forked-session',
								forked_from_id: 'parent-session',
								timestamp: '2025-09-16T10:00:00.000Z',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T10:00:00.001Z',
							type: 'session_meta',
							payload: {
								id: 'parent-session',
								timestamp: '2025-09-15T09:00:00.000Z',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T10:00:00.001Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						...replayLines,
						JSON.stringify({
							timestamp: '2025-09-16T10:00:00.050Z',
							type: 'event_msg',
							payload: {
								type: 'task_started',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T10:00:00.051Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5-mini',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T10:00:00.052Z',
							type: 'event_msg',
							payload: {
								type: 'user_message',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T10:00:02.500Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: replayTailInput + 120,
										cached_input_tokens: replayTailCachedInput + 20,
										output_tokens: replayTailOutput + 40,
										reasoning_output_tokens: 0,
										total_tokens: replayTailInput + replayTailOutput + 160,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				model: 'gpt-5-mini',
				inputTokens: 120,
				cachedInputTokens: 20,
				outputTokens: 40,
				reasoningOutputTokens: 0,
				totalTokens: 160,
			});
		});

		it('drops forked sessions that only replay parent history', async () => {
			const replayLines = buildReplayTokenLines({
				baseTimestamp: '2025-09-16T11:00:00.',
				count: 25,
				startInput: 500,
				startCachedInput: 50,
				startOutput: 200,
				model: 'gpt-5',
			});

			await using fixture = await createFixture({
				sessions: {
					'forked-replay-only.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-16T11:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'forked-session',
								forked_from_id: 'parent-session',
								timestamp: '2025-09-16T11:00:00.000Z',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T11:00:00.001Z',
							type: 'session_meta',
							payload: {
								id: 'parent-session',
								timestamp: '2025-09-15T09:00:00.000Z',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T11:00:00.002Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						...replayLines,
						JSON.stringify({
							timestamp: '2025-09-16T11:00:00.050Z',
							type: 'event_msg',
							payload: {
								type: 'task_started',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T11:00:00.051Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T11:00:00.052Z',
							type: 'event_msg',
							payload: {
								type: 'user_message',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T11:01:05.000Z',
							type: 'event_msg',
							payload: {
								type: 'task_complete',
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toEqual([]);
		});

		it('keeps normal forked sessions when the startup activity does not look like replay', async () => {
			await using fixture = await createFixture({
				sessions: {
					'forked-normal.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-16T12:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'forked-session',
								forked_from_id: 'parent-session',
								timestamp: '2025-09-16T12:00:00.000Z',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T12:00:00.010Z',
							type: 'session_meta',
							payload: {
								id: 'parent-session',
								timestamp: '2025-09-15T09:00:00.000Z',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T12:00:00.020Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T12:00:00.030Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 1_000,
										cached_input_tokens: 100,
										output_tokens: 400,
										reasoning_output_tokens: 0,
										total_tokens: 1_400,
									},
									last_token_usage: {
										input_tokens: 1_000,
										cached_input_tokens: 100,
										output_tokens: 400,
										reasoning_output_tokens: 0,
										total_tokens: 1_400,
									},
									model: 'gpt-5',
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T12:00:00.040Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 1_120,
										cached_input_tokens: 100,
										output_tokens: 460,
										reasoning_output_tokens: 0,
										total_tokens: 1_580,
									},
									last_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 0,
										output_tokens: 60,
										reasoning_output_tokens: 0,
										total_tokens: 180,
									},
									model: 'gpt-5',
								},
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T12:00:00.050Z',
							type: 'event_msg',
							payload: {
								type: 'task_started',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T12:00:00.060Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5-mini',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T12:00:02.500Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									total_token_usage: {
										input_tokens: 1_300,
										cached_input_tokens: 120,
										output_tokens: 520,
										reasoning_output_tokens: 0,
										total_tokens: 1_820,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(3);
			expect(events.map((event) => event.model)).toEqual(['gpt-5', 'gpt-5', 'gpt-5-mini']);
			expect(events.map((event) => event.totalTokens)).toEqual([1_400, 180, 240]);
		});
	});
}
