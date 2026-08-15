export type TokenUsageDelta = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
};

export type SessionStorageSource = 'active' | 'archived' | 'custom';

export type CodexNonTokenUsageEventType =
	| 'ambient_suggestion'
	| 'collab_agent_spawn_begin'
	| 'collab_agent_spawn_end'
	| 'image_generation_call'
	| 'model/rerouted'
	| 'model_rerouted'
	| 'spawn_agent'
	| 'thread/compacted'
	| 'thread/name/updated'
	| 'thread/settings/updated'
	| 'thread_compacted'
	| 'thread_name_updated'
	| 'thread_settings_applied'
	| 'thread_settings_updated'
	| 'wait_agent'
	| 'thread_title_updated'
	| 'thread_goal_updated'
	| 'conversation_summary';

export type CodexUsageCoverageAudit = {
	tokenCountEvents: number;
	fallbackModelTokenEvents: number;
	replayDroppedTokenEvents: number;
	nonTokenUsageEvents: Partial<Record<CodexNonTokenUsageEventType, number>>;
	nonTokenUsageModels: Partial<Record<CodexNonTokenUsageEventType, Record<string, number>>>;
};

export type TokenUsageEvent = TokenUsageDelta & {
	timestamp: string;
	sessionId: string;
	storageSource?: SessionStorageSource;
	sessionRoot?: string;
	model?: string;
	isFallbackModel?: boolean;
};

export type ModelUsage = TokenUsageDelta & {
	costUSD: number;
	isFallback?: boolean;
};

export type DailyUsageSummary = {
	date: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type MonthlyUsageSummary = {
	month: string;
	firstTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type SessionUsageSummary = {
	sessionId: string;
	storageSource: SessionStorageSource;
	firstTimestamp: string;
	lastTimestamp: string;
	costUSD: number;
	models: Map<string, ModelUsage>;
} & TokenUsageDelta;

export type ModelPricing = {
	inputCostPerMToken: number;
	cacheWriteInputCostPerMToken?: number;
	cachedInputCostPerMToken: number;
	outputCostPerMToken: number;
};

export type PricingLookupResult = {
	model: string;
	pricing: ModelPricing;
};

export type PricingSource = {
	getPricing: (model: string) => Promise<ModelPricing>;
};

export type DailyReportRow = {
	date: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type MonthlyReportRow = {
	month: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};

export type SessionReportRow = {
	sessionId: string;
	storageSource: SessionStorageSource;
	firstActivity: string;
	lastActivity: string;
	sessionFile: string;
	directory: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	costUSD: number;
	models: Record<string, ModelUsage>;
};
