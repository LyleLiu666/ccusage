import type {
	CodexNonTokenUsageEventType,
	CodexUsageCoverageAudit,
	SessionStorageSource,
	TokenUsageDelta,
	TokenUsageEvent,
} from './_types.ts';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	CODEX_HOME_ENV,
	DEFAULT_AMBIENT_SUGGESTIONS_SUBDIR,
	DEFAULT_ARCHIVED_SESSION_SUBDIR,
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
const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review';
const CODEX_AUTO_REVIEW_FALLBACK_MODEL = 'gpt-5';
/**
 * Codex logs record review runs under the internal `codex-auto-review` label,
 * which pricing sources never publish. Resolve each event to the newest
 * Codex/OpenAI model available on the event date (models.dev release dates).
 * Entries must stay in descending release-date order.
 */
const CODEX_AUTO_REVIEW_FALLBACK_MODELS: ReadonlyArray<{ releasedOn: string; model: string }> = [
	{ releasedOn: '2026-04-23', model: 'gpt-5.5' },
	{ releasedOn: '2026-03-05', model: 'gpt-5.4' },
	{ releasedOn: '2026-02-05', model: 'gpt-5.3-codex' },
	{ releasedOn: '2025-12-11', model: 'gpt-5.2-codex' },
	{ releasedOn: '2025-11-13', model: 'gpt-5.1-codex' },
	{ releasedOn: '2025-09-15', model: 'gpt-5-codex' },
	{ releasedOn: '2025-08-07', model: 'gpt-5' },
];

function isValidCalendarDate(date: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return false;
	}

	const [year, month, day] = date.split('-').map(Number) as [number, number, number];
	if (month < 1 || month > 12 || day < 1) {
		return false;
	}

	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

function resolveCodexLogModel(model: string, timestamp: string): string {
	if (model !== CODEX_AUTO_REVIEW_MODEL) {
		return model;
	}

	const date = timestamp.slice(0, 10);
	if (isValidCalendarDate(date)) {
		for (const fallback of CODEX_AUTO_REVIEW_FALLBACK_MODELS) {
			if (date >= fallback.releasedOn) {
				return fallback.model;
			}
		}
	}

	return CODEX_AUTO_REVIEW_FALLBACK_MODEL;
}

const entrySchema = v.object({
	type: v.string(),
	payload: v.optional(v.unknown()),
	timestamp: v.optional(v.string()),
});

const tokenCountPayloadSchema = v.object({
	type: v.literal('token_count'),
	info: v.optional(recordSchema),
});
const nonTokenUsageEventTypes = new Set<CodexNonTokenUsageEventType>([
	'ambient_suggestion',
	'collab_agent_spawn_begin',
	'collab_agent_spawn_end',
	'image_generation_call',
	'model/rerouted',
	'model_rerouted',
	'spawn_agent',
	'thread/compacted',
	'thread/name/updated',
	'thread/settings/updated',
	'thread_compacted',
	'thread_name_updated',
	'thread_settings_applied',
	'thread_settings_updated',
	'wait_agent',
	'thread_title_updated',
	'thread_goal_updated',
	'conversation_summary',
]);

const modelStateEventTypes = new Set([
	'model/rerouted',
	'model_rerouted',
	'thread/settings/updated',
	'thread_settings_applied',
	'thread_settings_updated',
]);

const FORK_REPLAY_GAP_MS = 1_000;
const FORK_REPLAY_MIN_TOKEN_EVENTS = 20;

type SessionEntry = v.InferOutput<typeof entrySchema>;
type ForkReplayDecision = 'pending' | 'keep' | 'drop';
type ForkReplayDetector = {
	foundFirstEntry: boolean;
	forkedSessionId?: string;
	sawParentSessionMeta: boolean;
	previousUniqueTimestamp?: string;
	previousUniqueTimestampMs?: number;
	tokenEventCount: number;
};

function createForkReplayDetector(): ForkReplayDetector {
	return {
		foundFirstEntry: false,
		sawParentSessionMeta: false,
		tokenEventCount: 0,
	};
}

/**
 * Decide whether the buffered prefix of a forked session is replayed lineage
 * history rather than new usage.
 *
 * Codex re-serializes the parent lineage (including the parent's
 * `session_meta`) at the start of a forked rollout file. Those replayed
 * `token_count` events duplicate usage that is already counted in the original
 * session files, so they must be dropped. Replay timestamps are not reliable
 * for detection: re-hydration may stamp every replayed entry with a single
 * shared timestamp, or spread distinct timestamps across more than one second
 * while re-hydrating large lineages. What IS reliable:
 *
 *   1. A foreign `session_meta` (different session id) only appears inside
 *      replayed lineage history.
 *   2. Real usage events are separated by model generation time, so a prefix
 *      of at least `FORK_REPLAY_MIN_TOKEN_EVENTS` token events with no gap of
 *      at least `FORK_REPLAY_GAP_MS` between consecutive entries can only have
 *      been machine-written replay.
 */
function isReplayedForkPrefix(detector: ForkReplayDetector): boolean {
	return detector.sawParentSessionMeta && detector.tokenEventCount >= FORK_REPLAY_MIN_TOKEN_EVENTS;
}

function advanceForkReplayDetector(
	detector: ForkReplayDetector,
	entry: SessionEntry,
): ForkReplayDecision {
	if (!detector.foundFirstEntry) {
		detector.foundFirstEntry = true;
		if (entry.type !== 'session_meta') {
			return 'keep';
		}

		const sessionMeta = v.safeParse(recordSchema, entry.payload ?? null);
		if (!sessionMeta.success) {
			return 'keep';
		}

		detector.forkedSessionId = asNonEmptyString(sessionMeta.output.id);
		const isForkedSession = asNonEmptyString(sessionMeta.output.forked_from_id) != null;
		if (!isForkedSession) {
			return 'keep';
		}
	} else if (entry.type === 'session_meta') {
		const sessionMeta = v.safeParse(recordSchema, entry.payload ?? null);
		if (sessionMeta.success) {
			const sessionId = asNonEmptyString(sessionMeta.output.id);
			if (sessionId != null && sessionId !== detector.forkedSessionId) {
				detector.sawParentSessionMeta = true;
			}
		}
	}

	const tokenPayloadResult = v.safeParse(tokenCountPayloadSchema, entry.payload ?? undefined);
	const isTokenEvent = tokenPayloadResult.success;
	const timestamp = entry.timestamp;

	if (timestamp == null || timestamp === detector.previousUniqueTimestamp) {
		if (isTokenEvent) {
			detector.tokenEventCount += 1;
		}
		return 'pending';
	}

	const timestampMs = Date.parse(timestamp);
	if (Number.isNaN(timestampMs)) {
		return 'pending';
	}

	if (
		detector.previousUniqueTimestampMs != null &&
		timestampMs - detector.previousUniqueTimestampMs >= FORK_REPLAY_GAP_MS
	) {
		return isReplayedForkPrefix(detector) ? 'drop' : 'keep';
	}

	if (isTokenEvent) {
		detector.tokenEventCount += 1;
	}

	detector.previousUniqueTimestamp = timestamp;
	detector.previousUniqueTimestampMs = timestampMs;
	return 'pending';
}

function parseEntryFromLine(line: string): SessionEntry | null {
	const parseLine = Result.try({
		try: () => JSON.parse(line) as unknown,
		catch: (error) => error,
	});
	const parsedResult = parseLine();
	if (Result.isFailure(parsedResult)) {
		return null;
	}

	const entryParse = v.safeParse(entrySchema, parsedResult.value);
	return entryParse.success ? entryParse.output : null;
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
			const directCandidates = [
				info.model,
				info.model_name,
				info.toModel,
				info.to_model,
				info.effectiveModel,
				info.effective_model,
				info.requestedModel,
				info.requested_model,
			];
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

	const fallbackModel =
		asNonEmptyString(payload.model) ??
		asNonEmptyString(payload.model_name) ??
		asNonEmptyString(payload.toModel) ??
		asNonEmptyString(payload.to_model) ??
		asNonEmptyString(payload.effectiveModel) ??
		asNonEmptyString(payload.effective_model) ??
		asNonEmptyString(payload.requestedModel) ??
		asNonEmptyString(payload.requested_model);
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

	if (payload.collaboration_mode != null) {
		const collaborationModeParsed = v.safeParse(recordSchema, payload.collaboration_mode);
		if (collaborationModeParsed.success) {
			const settingsParsed = v.safeParse(recordSchema, collaborationModeParsed.output.settings);
			if (settingsParsed.success) {
				const model = asNonEmptyString(settingsParsed.output.model);
				if (model != null) {
					return model;
				}
			}
		}
	}

	const nestedModelSources = [
		payload.threadSettings,
		payload.thread_settings,
		payload.item,
		payload.params,
	];
	for (const source of nestedModelSources) {
		const model = extractModel(source);
		if (model != null) {
			return model;
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
	ambientSuggestionDirs?: string[];
	/** Skip files with modification time before this timestamp (ms since epoch) */
	sinceTimestamp?: number;
};

export type LoadResult = {
	events: TokenUsageEvent[];
	missingDirectories: string[];
	coverage: CodexUsageCoverageAudit;
};

type SessionDirConfig = {
	path: string;
	storageSource: SessionStorageSource;
	optionalIfMissing: boolean;
};

function isMissingDirectoryError(error: unknown): boolean {
	if (typeof error !== 'object' || error == null || !('code' in error)) {
		return false;
	}

	return (error as { code?: string }).code === 'ENOENT';
}

function createEmptyCoverageAudit(): CodexUsageCoverageAudit {
	return {
		tokenCountEvents: 0,
		fallbackModelTokenEvents: 0,
		replayDroppedTokenEvents: 0,
		nonTokenUsageEvents: {},
		nonTokenUsageModels: {},
	};
}

function isInSinceWindow(
	timestamp: string | undefined,
	sinceTimestamp: number | undefined,
): boolean {
	if (sinceTimestamp == null || timestamp == null) {
		return true;
	}

	const timestampMs = Date.parse(timestamp);
	return Number.isNaN(timestampMs) || timestampMs >= sinceTimestamp;
}

function recordNonTokenUsageEvent(
	coverage: CodexUsageCoverageAudit,
	eventType: string | undefined,
	payload: unknown,
	timestamp: string | undefined,
	options: LoadOptions,
): void {
	if (
		eventType == null ||
		!nonTokenUsageEventTypes.has(eventType as CodexNonTokenUsageEventType) ||
		!isInSinceWindow(timestamp, options.sinceTimestamp)
	) {
		return;
	}

	const type = eventType as CodexNonTokenUsageEventType;
	coverage.nonTokenUsageEvents[type] = (coverage.nonTokenUsageEvents[type] ?? 0) + 1;

	const model = extractNonTokenUsageModel(payload);
	if (model != null) {
		const models = coverage.nonTokenUsageModels[type] ?? {};
		models[model] = (models[model] ?? 0) + 1;
		coverage.nonTokenUsageModels[type] = models;
	}
}

function extractNonTokenUsageModel(payload: unknown): string | undefined {
	const parsed = v.safeParse(recordSchema, payload);
	if (!parsed.success) {
		return undefined;
	}

	const direct = extractModel(parsed.output);
	if (direct != null) {
		return direct;
	}

	const argsParsed = v.safeParse(recordSchema, parsed.output.args);
	if (!argsParsed.success) {
		return undefined;
	}

	return extractModel(argsParsed.output);
}

function extractModelStateEventModel(
	eventType: string | undefined,
	payload: unknown,
): string | undefined {
	if (eventType == null || !modelStateEventTypes.has(eventType)) {
		return undefined;
	}

	return extractModel(payload);
}

async function recordAmbientSuggestionsCoverage(
	coverage: CodexUsageCoverageAudit,
	directories: string[],
	options: LoadOptions,
): Promise<void> {
	for (const directory of directories) {
		const filesResult = await Result.try({
			try: glob('**/ambient-suggestions.json', {
				cwd: directory,
				absolute: true,
				onlyFiles: true,
			}),
			catch: (error) => error,
		});
		if (Result.isFailure(filesResult)) {
			continue;
		}

		for (const file of filesResult.value) {
			const fileStatResult = await Result.try({
				try: stat(file),
				catch: (error) => error,
			});
			if (
				Result.isSuccess(fileStatResult) &&
				options.sinceTimestamp != null &&
				fileStatResult.value.mtime.getTime() < options.sinceTimestamp
			) {
				continue;
			}

			const contentResult = await Result.try({
				try: readFile(file, 'utf8'),
				catch: (error) => error,
			});
			if (Result.isFailure(contentResult)) {
				continue;
			}

			const parsedResult = Result.try({
				try: () => JSON.parse(contentResult.value) as unknown,
				catch: (error) => error,
			})();
			const generatedAtMs =
				Result.isSuccess(parsedResult) &&
				parsedResult.value != null &&
				typeof parsedResult.value === 'object'
					? ensureNumber((parsedResult.value as Record<string, unknown>).generatedAtMs)
					: 0;
			if (
				generatedAtMs > 0 &&
				options.sinceTimestamp != null &&
				generatedAtMs < options.sinceTimestamp
			) {
				continue;
			}

			coverage.nonTokenUsageEvents.ambient_suggestion =
				(coverage.nonTokenUsageEvents.ambient_suggestion ?? 0) + 1;
		}
	}
}

function tokenUsageEventKey(event: TokenUsageEvent): string {
	return [
		event.timestamp,
		event.model ?? '',
		event.inputTokens,
		event.cachedInputTokens,
		event.outputTokens,
		event.reasoningOutputTokens,
		event.totalTokens,
	].join('\0');
}

function dedupeCopiedTokenEvents(events: TokenUsageEvent[]): void {
	const seen = new Set<string>();
	let writeIndex = 0;

	for (const event of events) {
		const key = tokenUsageEventKey(event);
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		events[writeIndex] = event;
		writeIndex += 1;
	}

	events.length = writeIndex;
}

export async function loadTokenUsageEvents(options: LoadOptions = {}): Promise<LoadResult> {
	const providedDirs =
		options.sessionDirs != null && options.sessionDirs.length > 0
			? options.sessionDirs.map((dir) => path.resolve(dir))
			: undefined;

	const codexHomeEnv = process.env[CODEX_HOME_ENV]?.trim();
	const codexHome =
		codexHomeEnv != null && codexHomeEnv !== '' ? path.resolve(codexHomeEnv) : DEFAULT_CODEX_DIR;
	const sessionDirs: SessionDirConfig[] = providedDirs?.map((dir) => ({
		path: dir,
		storageSource: 'custom',
		optionalIfMissing: false,
	})) ?? [
		{
			path: path.join(codexHome, DEFAULT_SESSION_SUBDIR),
			storageSource: 'active',
			optionalIfMissing: false,
		},
		{
			path: path.join(codexHome, DEFAULT_ARCHIVED_SESSION_SUBDIR),
			storageSource: 'archived',
			optionalIfMissing: true,
		},
	];
	const ambientSuggestionDirs =
		options.ambientSuggestionDirs?.map((dir) => path.resolve(dir)) ??
		(providedDirs == null ? [path.join(codexHome, DEFAULT_AMBIENT_SUGGESTIONS_SUBDIR)] : []);

	const events: TokenUsageEvent[] = [];
	const missingDirectories: string[] = [];
	const coverage = createEmptyCoverageAudit();

	for (const sessionDir of sessionDirs) {
		const directoryPath = path.resolve(sessionDir.path);
		const statResult = await Result.try({
			try: stat(directoryPath),
			catch: (error) => error,
		});

		if (Result.isFailure(statResult)) {
			if (!(sessionDir.optionalIfMissing && isMissingDirectoryError(statResult.error))) {
				missingDirectories.push(directoryPath);
			}
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
		files.sort((a, b) => a.localeCompare(b));

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
			let previousTotals: RawUsage | null = null;
			let currentModel: string | undefined;
			let currentModelIsFallback = false;
			let legacyFallbackUsed = false;
			const replayDetector = createForkReplayDetector();
			let replayDecision: ForkReplayDecision = 'pending';
			const bufferedEvents: TokenUsageEvent[] = [];
			const dropReplayedEvents = (): void => {
				for (const droppedEvent of bufferedEvents) {
					if (isInSinceWindow(droppedEvent.timestamp, options.sinceTimestamp)) {
						coverage.replayDroppedTokenEvents += 1;
					}
				}
				bufferedEvents.length = 0;
			};
			const input = createReadStream(file, { encoding: 'utf8' });
			const lineReader = createInterface({
				input,
				crlfDelay: Infinity,
			});

			try {
				for await (const line of lineReader) {
					const trimmed = line.trim();
					if (trimmed === '') {
						continue;
					}

					const entry = parseEntryFromLine(trimmed);
					if (entry == null) {
						continue;
					}

					if (replayDecision === 'pending') {
						const nextDecision = advanceForkReplayDetector(replayDetector, entry);
						if (nextDecision === 'drop') {
							dropReplayedEvents();
						} else if (nextDecision === 'keep') {
							events.push(...bufferedEvents);
							bufferedEvents.length = 0;
						}
						replayDecision = nextDecision;
					}

					const { type: entryType, payload, timestamp } = entry;

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

					const eventPayload = v.safeParse(recordSchema, payload ?? undefined);
					const eventType = eventPayload.success
						? asNonEmptyString(eventPayload.output.type)
						: undefined;
					recordNonTokenUsageEvent(coverage, eventType, payload, timestamp, options);

					const stateEventModel = extractModelStateEventModel(eventType, payload);
					if (stateEventModel != null) {
						currentModel = stateEventModel;
						currentModelIsFallback = false;
					}

					const tokenPayloadResult = v.safeParse(tokenCountPayloadSchema, payload ?? undefined);
					if (!tokenPayloadResult.success || timestamp == null) {
						continue;
					}
					if (isInSinceWindow(timestamp, options.sinceTimestamp)) {
						coverage.tokenCountEvents += 1;
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

					if (model === CODEX_AUTO_REVIEW_MODEL) {
						model = resolveCodexLogModel(model, timestamp);
						isFallbackModel = true;
					}

					const event: TokenUsageEvent = {
						sessionId,
						storageSource: sessionDir.storageSource,
						sessionRoot: directoryPath,
						timestamp,
						model,
						inputTokens: delta.inputTokens,
						cachedInputTokens: delta.cachedInputTokens,
						outputTokens: delta.outputTokens,
						reasoningOutputTokens: delta.reasoningOutputTokens,
						totalTokens: delta.totalTokens,
					};

					if (isFallbackModel) {
						event.isFallbackModel = true;
						if (isInSinceWindow(timestamp, options.sinceTimestamp)) {
							coverage.fallbackModelTokenEvents += 1;
						}
					}

					if (replayDecision === 'pending') {
						bufferedEvents.push(event);
					} else {
						events.push(event);
					}
				}
			} catch (error) {
				logger.debug('Failed to read Codex session file', error);
				continue;
			} finally {
				lineReader.close();
				input.destroy();
			}

			if (replayDecision === 'pending') {
				if (isReplayedForkPrefix(replayDetector)) {
					// Replay-only forked session: the buffered prefix is copied
					// lineage history with no new activity after it.
					dropReplayedEvents();
				} else {
					events.push(...bufferedEvents);
				}
			}

			if (legacyFallbackUsed) {
				logger.debug('Legacy Codex session lacked model metadata; applied fallback', {
					file,
					model: LEGACY_FALLBACK_MODEL,
				});
			}
		}
	}

	await recordAmbientSuggestionsCoverage(coverage, ambientSuggestionDirs, options);

	dedupeCopiedTokenEvents(events);
	events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	return { events, missingDirectories, coverage };
}

if (import.meta.vitest != null) {
	describe('loadTokenUsageEvents', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

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

		it('resolves codex-auto-review to the newest model available on the event date', async () => {
			const reviewLine = (timestamp: string) =>
				JSON.stringify({
					timestamp,
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							last_token_usage: {
								input_tokens: 10,
								cached_input_tokens: 0,
								output_tokens: 5,
								reasoning_output_tokens: 0,
								total_tokens: 15,
							},
							model: 'codex-auto-review',
						},
					},
				});

			await using fixture = await createFixture({
				sessions: {
					'review.jsonl': [
						reviewLine('2026-05-01T10:00:00.000Z'),
						reviewLine('2025-10-01T10:00:00.000Z'),
						reviewLine('not-a-valid-timestamp'),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(3);
			// Events are sorted by timestamp before returning.
			expect(events[0]!.model).toBe('gpt-5-codex');
			expect(events[1]!.model).toBe('gpt-5.5');
			expect(events[2]!.model).toBe('gpt-5');
			for (const event of events) {
				expect(event.isFallbackModel).toBe(true);
			}
		});

		it('reads the model from collaboration mode settings when turn context lacks a direct model', async () => {
			await using fixture = await createFixture({
				sessions: {
					'collaboration-mode-model.jsonl': [
						JSON.stringify({
							timestamp: '2026-06-29T08:00:00.000Z',
							type: 'turn_context',
							payload: {
								collaboration_mode: {
									settings: {
										model: 'gpt-5.4-mini',
									},
								},
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 10,
										output_tokens: 40,
										reasoning_output_tokens: 5,
										total_tokens: 140,
									},
									total_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 10,
										output_tokens: 40,
										reasoning_output_tokens: 5,
										total_tokens: 140,
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
			expect(events[0]!.model).toBe('gpt-5.4-mini');
			expect(events[0]!.isFallbackModel).toBeUndefined();
		});

		it('updates the current model from thread settings events', async () => {
			await using fixture = await createFixture({
				sessions: {
					'thread-settings-model.jsonl': [
						JSON.stringify({
							timestamp: '2026-06-29T08:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5.5',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'thread_settings_updated',
								threadSettings: {
									model: 'gpt-5.4',
								},
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:02.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 20,
										output_tokens: 50,
										reasoning_output_tokens: 10,
										total_tokens: 170,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { coverage, events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(1);
			expect(events[0]!.model).toBe('gpt-5.4');
			expect(events[0]!.isFallbackModel).toBeUndefined();
			expect(coverage.nonTokenUsageEvents.thread_settings_updated).toBe(1);
			expect(coverage.nonTokenUsageModels.thread_settings_updated).toEqual({
				'gpt-5.4': 1,
			});
		});

		it('uses the rerouted destination model for following token_count events', async () => {
			await using fixture = await createFixture({
				sessions: {
					'model-rerouted.jsonl': [
						JSON.stringify({
							timestamp: '2026-06-29T08:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5.5',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'model/rerouted',
								fromModel: 'gpt-5.5',
								toModel: 'gpt-5.1-codex-mini',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:02.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 80,
										cached_input_tokens: 5,
										output_tokens: 30,
										reasoning_output_tokens: 5,
										total_tokens: 110,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { coverage, events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(1);
			expect(events[0]!.model).toBe('gpt-5.1-codex-mini');
			expect(events[0]!.isFallbackModel).toBeUndefined();
			expect(coverage.nonTokenUsageEvents['model/rerouted']).toBe(1);
			expect(coverage.nonTokenUsageModels['model/rerouted']).toEqual({
				'gpt-5.1-codex-mini': 1,
			});
		});

		it('audits Codex events that are not represented as token_count usage', async () => {
			await using fixture = await createFixture({
				sessions: {
					'coverage.jsonl': [
						JSON.stringify({
							timestamp: '2026-06-29T08:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'image_generation_call',
								status: 'completed',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:02.000Z',
							type: 'event_msg',
							payload: {
								type: 'spawn_agent',
								args: {
									model: 'gpt-5.1-codex-mini',
								},
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:02.500Z',
							type: 'event_msg',
							payload: {
								type: 'collab_agent_spawn_end',
								model: 'gpt-5.3-codex-spark',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:03.000Z',
							type: 'event_msg',
							payload: {
								type: 'thread_title_updated',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:03.250Z',
							type: 'event_msg',
							payload: {
								type: 'thread/name/updated',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:03.500Z',
							type: 'event_msg',
							payload: {
								type: 'thread_compacted',
							},
						}),
						JSON.stringify({
							timestamp: '2026-06-29T08:00:04.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 0,
										output_tokens: 30,
										reasoning_output_tokens: 0,
										total_tokens: 130,
									},
								},
							},
						}),
					].join('\n'),
				},
			});

			const { coverage } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(coverage).toEqual({
				tokenCountEvents: 1,
				fallbackModelTokenEvents: 0,
				replayDroppedTokenEvents: 0,
				nonTokenUsageEvents: {
					collab_agent_spawn_end: 1,
					image_generation_call: 1,
					spawn_agent: 1,
					'thread/name/updated': 1,
					thread_compacted: 1,
					thread_title_updated: 1,
				},
				nonTokenUsageModels: {
					collab_agent_spawn_end: {
						'gpt-5.3-codex-spark': 1,
					},
					spawn_agent: {
						'gpt-5.1-codex-mini': 1,
					},
				},
			});
		});

		it('audits ambient suggestions outside session token_count logs', async () => {
			await using fixture = await createFixture({
				sessions: {
					'usage.jsonl': JSON.stringify({
						timestamp: '2026-06-29T08:00:00.000Z',
						type: 'event_msg',
						payload: {
							type: 'token_count',
							info: {
								model: 'gpt-5',
								last_token_usage: {
									input_tokens: 10,
									cached_input_tokens: 0,
									output_tokens: 5,
									reasoning_output_tokens: 0,
									total_tokens: 15,
								},
							},
						},
					}),
				},
				ambient: {
					project: {
						'ambient-suggestions.json': JSON.stringify({
							generatedAtMs: new Date('2026-06-29T08:00:01.000Z').getTime(),
							suggestions: [{ title: 'Review recent edits' }],
						}),
					},
				},
			});

			const { coverage } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
				ambientSuggestionDirs: [fixture.getPath('ambient')],
				sinceTimestamp: new Date('2026-06-29T00:00:00.000Z').getTime(),
			});

			expect(coverage.nonTokenUsageEvents.ambient_suggestion).toBe(1);
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

		it('drops fork replay when replayed events share a single timestamp', async () => {
			const replayLines = Array.from({ length: 25 }, () =>
				JSON.stringify({
					timestamp: '2025-09-16T13:00:00.100Z',
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							last_token_usage: {
								input_tokens: 500,
								cached_input_tokens: 50,
								output_tokens: 40,
								reasoning_output_tokens: 0,
								total_tokens: 540,
							},
							model: 'gpt-5',
						},
					},
				}),
			);

			await using fixture = await createFixture({
				sessions: {
					'forked-shared-timestamp.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-16T13:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'forked-session',
								forked_from_id: 'parent-session',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T13:00:00.001Z',
							type: 'session_meta',
							payload: {
								id: 'parent-session',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T13:00:00.002Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						...replayLines,
						JSON.stringify({
							timestamp: '2025-09-16T13:00:05.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 20,
										output_tokens: 60,
										reasoning_output_tokens: 0,
										total_tokens: 180,
									},
									model: 'gpt-5',
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events, coverage } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				inputTokens: 120,
				outputTokens: 60,
			});
			expect(coverage.replayDroppedTokenEvents).toBe(25);
		});

		it('drops fork replay when re-hydration spreads timestamps across more than one second', async () => {
			const replayLines = Array.from({ length: 25 }, (_, index) =>
				JSON.stringify({
					timestamp: `2025-09-16T14:00:${String(Math.floor((index * 100) / 1000)).padStart(2, '0')}.${String((index * 100) % 1000).padStart(3, '0')}Z`,
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							last_token_usage: {
								input_tokens: 500,
								cached_input_tokens: 50,
								output_tokens: 40,
								reasoning_output_tokens: 0,
								total_tokens: 540,
							},
							model: 'gpt-5',
						},
					},
				}),
			);

			await using fixture = await createFixture({
				sessions: {
					'forked-slow-rehydration.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-16T14:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'forked-session',
								forked_from_id: 'parent-session',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T14:00:00.001Z',
							type: 'session_meta',
							payload: {
								id: 'parent-session',
							},
						}),
						...replayLines,
						JSON.stringify({
							timestamp: '2025-09-16T14:00:05.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 120,
										cached_input_tokens: 20,
										output_tokens: 60,
										reasoning_output_tokens: 0,
										total_tokens: 180,
									},
									model: 'gpt-5',
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events, coverage } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				inputTokens: 120,
				outputTokens: 60,
			});
			expect(coverage.replayDroppedTokenEvents).toBe(25);
		});

		it('drops replay-only forked sessions at end of file', async () => {
			const replayLines = Array.from({ length: 25 }, () =>
				JSON.stringify({
					timestamp: '2025-09-16T15:00:00.100Z',
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							last_token_usage: {
								input_tokens: 500,
								cached_input_tokens: 50,
								output_tokens: 40,
								reasoning_output_tokens: 0,
								total_tokens: 540,
							},
							model: 'gpt-5',
						},
					},
				}),
			);

			await using fixture = await createFixture({
				sessions: {
					'forked-replay-only-eof.jsonl': [
						JSON.stringify({
							timestamp: '2025-09-16T15:00:00.000Z',
							type: 'session_meta',
							payload: {
								id: 'forked-session',
								forked_from_id: 'parent-session',
							},
						}),
						JSON.stringify({
							timestamp: '2025-09-16T15:00:00.001Z',
							type: 'session_meta',
							payload: {
								id: 'parent-session',
							},
						}),
						...replayLines,
					].join('\n'),
				},
			});

			const { events, coverage } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toEqual([]);
			expect(coverage.replayDroppedTokenEvents).toBe(25);
		});

		it('dedupes copied branch history across session files', async () => {
			const parentHistory = [
				JSON.stringify({
					timestamp: '2026-05-12T08:00:00.000Z',
					type: 'turn_context',
					payload: {
						model: 'gpt-5.2',
					},
				}),
				JSON.stringify({
					timestamp: '2026-05-12T08:01:00.000Z',
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 1_000,
								cached_input_tokens: 100,
								output_tokens: 200,
								reasoning_output_tokens: 20,
								total_tokens: 1_200,
							},
						},
					},
				}),
			].join('\n');
			const branchHistory = [
				parentHistory,
				JSON.stringify({
					timestamp: '2026-05-12T08:02:00.000Z',
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 1_600,
								cached_input_tokens: 300,
								output_tokens: 450,
								reasoning_output_tokens: 40,
								total_tokens: 2_050,
							},
						},
					},
				}),
			].join('\n');

			await using fixture = await createFixture({
				sessions: {
					'2026-05-12T08-00-00-parent.jsonl': parentHistory,
					'2026-05-12T08-02-00-branch.jsonl': branchHistory,
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('sessions')],
			});

			expect(events).toHaveLength(2);
			expect(events[0]).toMatchObject({
				sessionId: '2026-05-12T08-00-00-parent',
				inputTokens: 1_000,
				cachedInputTokens: 100,
				outputTokens: 200,
				reasoningOutputTokens: 20,
				totalTokens: 1_200,
			});
			expect(events[1]).toMatchObject({
				sessionId: '2026-05-12T08-02-00-branch',
				inputTokens: 600,
				cachedInputTokens: 200,
				outputTokens: 250,
				reasoningOutputTokens: 20,
				totalTokens: 850,
			});
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

		it('loads archived sessions from the default Codex home', async () => {
			await using fixture = await createFixture({
				sessions: {
					'2026/04/18/active-session.jsonl': [
						JSON.stringify({
							timestamp: '2026-04-18T08:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2026-04-18T08:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 0,
										output_tokens: 40,
										reasoning_output_tokens: 0,
										total_tokens: 140,
									},
									total_token_usage: {
										input_tokens: 100,
										cached_input_tokens: 0,
										output_tokens: 40,
										reasoning_output_tokens: 0,
										total_tokens: 140,
									},
									model: 'gpt-5',
								},
							},
						}),
					].join('\n'),
				},
				archived_sessions: {
					'archived-session.jsonl': [
						JSON.stringify({
							timestamp: '2026-04-17T08:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5-mini',
							},
						}),
						JSON.stringify({
							timestamp: '2026-04-17T08:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 80,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 100,
									},
									total_token_usage: {
										input_tokens: 80,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 100,
									},
									model: 'gpt-5-mini',
								},
							},
						}),
					].join('\n'),
				},
			});

			vi.stubEnv(CODEX_HOME_ENV, fixture.path);

			const { events, missingDirectories } = await loadTokenUsageEvents();

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(2);
			expect(events.map((event) => event.sessionId)).toEqual([
				'archived-session',
				'2026/04/18/active-session',
			]);
			expect(events.map((event) => event.storageSource)).toEqual(['archived', 'active']);
			expect(events.map((event) => event.model)).toEqual(['gpt-5-mini', 'gpt-5']);
		});

		it('does not warn when archived sessions directory is absent', async () => {
			await using fixture = await createFixture({
				sessions: {
					'2026/04/18/active-only.jsonl': [
						JSON.stringify({
							timestamp: '2026-04-18T09:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2026-04-18T09:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 60,
										cached_input_tokens: 0,
										output_tokens: 30,
										reasoning_output_tokens: 0,
										total_tokens: 90,
									},
									total_token_usage: {
										input_tokens: 60,
										cached_input_tokens: 0,
										output_tokens: 30,
										reasoning_output_tokens: 0,
										total_tokens: 90,
									},
									model: 'gpt-5',
								},
							},
						}),
					].join('\n'),
				},
			});

			vi.stubEnv(CODEX_HOME_ENV, fixture.path);

			const { events, missingDirectories } = await loadTokenUsageEvents();

			expect(missingDirectories).toEqual([]);
			expect(events).toHaveLength(1);
			expect(events[0]?.sessionId).toBe('2026/04/18/active-only');
		});

		it('warns when archived sessions path exists but is not a directory', async () => {
			await using fixture = await createFixture({
				sessions: {
					'2026/04/18/active-only.jsonl': [
						JSON.stringify({
							timestamp: '2026-04-18T09:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2026-04-18T09:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 60,
										cached_input_tokens: 0,
										output_tokens: 30,
										reasoning_output_tokens: 0,
										total_tokens: 90,
									},
									total_token_usage: {
										input_tokens: 60,
										cached_input_tokens: 0,
										output_tokens: 30,
										reasoning_output_tokens: 0,
										total_tokens: 90,
									},
									model: 'gpt-5',
								},
							},
						}),
					].join('\n'),
				},
				archived_sessions: 'not-a-directory',
			});

			vi.stubEnv(CODEX_HOME_ENV, fixture.path);

			const { events, missingDirectories } = await loadTokenUsageEvents();

			expect(events).toHaveLength(1);
			expect(missingDirectories).toEqual([fixture.getPath('archived_sessions')]);
		});

		it('keeps the session root on events loaded from multiple custom directories', async () => {
			await using fixture = await createFixture({
				rootA: {
					'shared/session.jsonl': [
						JSON.stringify({
							timestamp: '2026-04-18T10:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5',
							},
						}),
						JSON.stringify({
							timestamp: '2026-04-18T10:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 50,
										cached_input_tokens: 0,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 60,
									},
									total_token_usage: {
										input_tokens: 50,
										cached_input_tokens: 0,
										output_tokens: 10,
										reasoning_output_tokens: 0,
										total_tokens: 60,
									},
									model: 'gpt-5',
								},
							},
						}),
					].join('\n'),
				},
				rootB: {
					'shared/session.jsonl': [
						JSON.stringify({
							timestamp: '2026-04-18T11:00:00.000Z',
							type: 'turn_context',
							payload: {
								model: 'gpt-5-mini',
							},
						}),
						JSON.stringify({
							timestamp: '2026-04-18T11:00:01.000Z',
							type: 'event_msg',
							payload: {
								type: 'token_count',
								info: {
									last_token_usage: {
										input_tokens: 30,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 50,
									},
									total_token_usage: {
										input_tokens: 30,
										cached_input_tokens: 0,
										output_tokens: 20,
										reasoning_output_tokens: 0,
										total_tokens: 50,
									},
									model: 'gpt-5-mini',
								},
							},
						}),
					].join('\n'),
				},
			});

			const { events } = await loadTokenUsageEvents({
				sessionDirs: [fixture.getPath('rootA'), fixture.getPath('rootB')],
			});

			expect(events.map((event) => event.storageSource)).toEqual(['custom', 'custom']);
			expect(events.map((event) => event.sessionId)).toEqual(['shared/session', 'shared/session']);
			expect(events.map((event) => event.sessionRoot)).toEqual([
				fixture.getPath('rootA'),
				fixture.getPath('rootB'),
			]);
		});
	});
}
