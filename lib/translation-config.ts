const DEFAULT_GEMINI_MODEL_NAME = "gemini-3-flash-preview";
const DEFAULT_GEMINI_BATCH_TOKENS = 350;
const MIN_GEMINI_BATCH_TOKENS = 100;
const MAX_GEMINI_BATCH_TOKENS = 2_000;
const GEMINI_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
const DEFAULT_GEMINI_THINKING_LEVEL = "low";

export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

export type TranslationRuntimeConfig = {
	modelName: string;
	maxTokensPerRequest: number;
	thinkingLevel: GeminiThinkingLevel;
	isGemini3Model: boolean;
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

export function resolveTranslationRuntimeConfig(): TranslationRuntimeConfigResult {
	// Netlify-specific overrides come first so they can explicitly win over generic keys.
	const modelName =
		getFirstDefinedEnvValue(["NETLIFY_GEMINI_MODEL_NAME", "GEMINI_MODEL_NAME"]) ||
		DEFAULT_GEMINI_MODEL_NAME;
	const isGemini3Model = modelName.startsWith("gemini-3");

	const thinkingLevelRaw = getFirstDefinedEnvValue([
		"NETLIFY_GEMINI_THINKING_LEVEL",
		"GEMINI_THINKING_LEVEL",
	]);
	let thinkingLevel: GeminiThinkingLevel = DEFAULT_GEMINI_THINKING_LEVEL;
	if (thinkingLevelRaw) {
		if (!isGeminiThinkingLevel(thinkingLevelRaw)) {
			return {
				config: {
					modelName,
					maxTokensPerRequest: DEFAULT_GEMINI_BATCH_TOKENS,
					thinkingLevel,
					isGemini3Model,
				},
				error:
					'Invalid GEMINI_THINKING_LEVEL value. Use one of: "minimal", "low", "medium", "high".',
			};
		}
		thinkingLevel = thinkingLevelRaw;
	}

	const batchTokenLimitRaw = getFirstDefinedEnvValue([
		"NETLIFY_GEMINI_BATCH_TOKENS",
		"GEMINI_BATCH_TOKENS",
	]);

	let maxTokensPerRequest = DEFAULT_GEMINI_BATCH_TOKENS;
	if (batchTokenLimitRaw) {
		const parsed = Number.parseInt(batchTokenLimitRaw, 10);
		if (!Number.isFinite(parsed)) {
			return {
				config: {
					modelName,
					maxTokensPerRequest,
					thinkingLevel,
					isGemini3Model,
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
					thinkingLevel,
					isGemini3Model,
				},
				error:
					"Invalid GEMINI_BATCH_TOKENS value. Use an integer between 100 and 2000.",
			};
		}
		maxTokensPerRequest = parsed;
	}

	return {
		config: {
			modelName,
			maxTokensPerRequest,
			thinkingLevel,
			isGemini3Model,
		},
		error: null,
	};
}
