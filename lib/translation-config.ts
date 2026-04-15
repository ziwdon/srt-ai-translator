import type { ProhibitedContentPolicy } from "@/types";

const DEFAULT_GEMINI_MODEL_NAME = "gemini-3-flash-preview";
const DEFAULT_GEMINI_BATCH_TOKENS = 350;
const MIN_GEMINI_BATCH_TOKENS = 100;
const MAX_GEMINI_BATCH_TOKENS = 2_000;
const DEFAULT_MAX_PARALLEL = 5;
const MIN_MAX_PARALLEL = 1;
const MAX_MAX_PARALLEL = 20;
const GEMINI_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
const DEFAULT_GEMINI_THINKING_LEVEL = "low";
const PROHIBITED_CONTENT_POLICIES = [
	"keep_original",
	"placeholder",
	"redact",
] as const;
const DEFAULT_PROHIBITED_CONTENT_POLICY: ProhibitedContentPolicy = "keep_original";
const DEFAULT_PROHIBITED_CONTENT_PLACEHOLDER = "[Content not available]";
const DEFAULT_MAX_SPLIT_DEPTH = 5;
const MIN_MAX_SPLIT_DEPTH = 1;
const MAX_MAX_SPLIT_DEPTH = 10;

export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

export type TranslationRuntimeConfig = {
	modelName: string;
	maxTokensPerRequest: number;
	maxParallel: number;
	thinkingLevel: GeminiThinkingLevel;
	isGemini3Model: boolean;
	prohibitedContentPolicy: ProhibitedContentPolicy;
	prohibitedContentPlaceholder: string;
	maxSplitDepth: number;
};

type TranslationRuntimeConfigResult = {
	config: TranslationRuntimeConfig;
	error: string | null;
};

function getFirstDefinedEnvValue(keys: string[]): string | null {
	for (const key of keys) {
		const value = process.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return null;
}

function isGeminiThinkingLevel(value: string): value is GeminiThinkingLevel {
	return GEMINI_THINKING_LEVELS.includes(value as GeminiThinkingLevel);
}

function isProhibitedContentPolicy(value: string): value is ProhibitedContentPolicy {
	return PROHIBITED_CONTENT_POLICIES.includes(value as ProhibitedContentPolicy);
}

export function resolveTranslationRuntimeConfig(): TranslationRuntimeConfigResult {
	const modelName =
		getFirstDefinedEnvValue(["GEMINI_MODEL_NAME"]) || DEFAULT_GEMINI_MODEL_NAME;
	const isGemini3Model = modelName.startsWith("gemini-3");

	const thinkingLevelRaw = getFirstDefinedEnvValue(["GEMINI_THINKING_LEVEL"]);
	let thinkingLevel: GeminiThinkingLevel = DEFAULT_GEMINI_THINKING_LEVEL;
	if (thinkingLevelRaw) {
		if (!isGeminiThinkingLevel(thinkingLevelRaw)) {
			return {
				config: {
					modelName,
					maxTokensPerRequest: DEFAULT_GEMINI_BATCH_TOKENS,
					maxParallel: DEFAULT_MAX_PARALLEL,
					thinkingLevel,
					isGemini3Model,
					prohibitedContentPolicy: DEFAULT_PROHIBITED_CONTENT_POLICY,
					prohibitedContentPlaceholder: DEFAULT_PROHIBITED_CONTENT_PLACEHOLDER,
					maxSplitDepth: DEFAULT_MAX_SPLIT_DEPTH,
				},
				error:
					'Invalid GEMINI_THINKING_LEVEL value. Use one of: "minimal", "low", "medium", "high".',
			};
		}
		thinkingLevel = thinkingLevelRaw;
	}

	const batchTokenLimitRaw = getFirstDefinedEnvValue(["GEMINI_BATCH_TOKENS"]);

	let maxTokensPerRequest = DEFAULT_GEMINI_BATCH_TOKENS;
	if (batchTokenLimitRaw) {
		const parsed = Number.parseInt(batchTokenLimitRaw, 10);
		if (!Number.isFinite(parsed)) {
			return {
				config: {
					modelName,
					maxTokensPerRequest,
					maxParallel: DEFAULT_MAX_PARALLEL,
					thinkingLevel,
					isGemini3Model,
					prohibitedContentPolicy: DEFAULT_PROHIBITED_CONTENT_POLICY,
					prohibitedContentPlaceholder: DEFAULT_PROHIBITED_CONTENT_PLACEHOLDER,
					maxSplitDepth: DEFAULT_MAX_SPLIT_DEPTH,
				},
				error:
					"Invalid GEMINI_BATCH_TOKENS value. Use an integer between 100 and 2000.",
			};
		}
		if (parsed < MIN_GEMINI_BATCH_TOKENS || parsed > MAX_GEMINI_BATCH_TOKENS) {
			return {
				config: {
					modelName,
					maxTokensPerRequest,
					maxParallel: DEFAULT_MAX_PARALLEL,
					thinkingLevel,
					isGemini3Model,
					prohibitedContentPolicy: DEFAULT_PROHIBITED_CONTENT_POLICY,
					prohibitedContentPlaceholder: DEFAULT_PROHIBITED_CONTENT_PLACEHOLDER,
					maxSplitDepth: DEFAULT_MAX_SPLIT_DEPTH,
				},
				error:
					"Invalid GEMINI_BATCH_TOKENS value. Use an integer between 100 and 2000.",
			};
		}
		maxTokensPerRequest = parsed;
	}

	const maxParallelRaw = getFirstDefinedEnvValue(["TRANSLATION_MAX_PARALLEL"]);
	let maxParallel = DEFAULT_MAX_PARALLEL;
	if (maxParallelRaw) {
		const parsed = Number.parseInt(maxParallelRaw, 10);
		if (
			Number.isFinite(parsed) &&
			parsed >= MIN_MAX_PARALLEL &&
			parsed <= MAX_MAX_PARALLEL
		) {
			maxParallel = parsed;
		}
	}

	const prohibitedContentPolicyRaw = getFirstDefinedEnvValue([
		"PROHIBITED_CONTENT_POLICY",
	]);
	let prohibitedContentPolicy = DEFAULT_PROHIBITED_CONTENT_POLICY;
	if (prohibitedContentPolicyRaw) {
		if (isProhibitedContentPolicy(prohibitedContentPolicyRaw)) {
			prohibitedContentPolicy = prohibitedContentPolicyRaw;
		} else {
			console.warn(
				`Invalid PROHIBITED_CONTENT_POLICY value "${prohibitedContentPolicyRaw}". Falling back to "${DEFAULT_PROHIBITED_CONTENT_POLICY}".`,
			);
		}
	}

	const prohibitedContentPlaceholderRaw = process.env.PROHIBITED_CONTENT_PLACEHOLDER;
	const prohibitedContentPlaceholder =
		typeof prohibitedContentPlaceholderRaw === "string" &&
		prohibitedContentPlaceholderRaw.trim().length > 0
			? prohibitedContentPlaceholderRaw
			: DEFAULT_PROHIBITED_CONTENT_PLACEHOLDER;

	const maxSplitDepthRaw = getFirstDefinedEnvValue([
		"PROHIBITED_CONTENT_MAX_SPLIT_DEPTH",
	]);
	let maxSplitDepth = DEFAULT_MAX_SPLIT_DEPTH;
	if (maxSplitDepthRaw) {
		const parsed = Number.parseInt(maxSplitDepthRaw, 10);
		if (
			Number.isFinite(parsed) &&
			parsed >= MIN_MAX_SPLIT_DEPTH &&
			parsed <= MAX_MAX_SPLIT_DEPTH
		) {
			maxSplitDepth = parsed;
		} else {
			console.warn(
				`Invalid PROHIBITED_CONTENT_MAX_SPLIT_DEPTH value "${maxSplitDepthRaw}". Falling back to ${DEFAULT_MAX_SPLIT_DEPTH}.`,
			);
		}
	}

	return {
		config: {
			modelName,
			maxTokensPerRequest,
			maxParallel,
			thinkingLevel,
			isGemini3Model,
			prohibitedContentPolicy,
			prohibitedContentPlaceholder,
			maxSplitDepth,
		},
		error: null,
	};
}
