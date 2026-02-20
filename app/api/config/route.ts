import { resolveTranslationRuntimeConfig } from "@/lib/translation-config";

export const dynamic = "force-dynamic";

export async function GET() {
	const hasKey = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
	const { config, error } = resolveTranslationRuntimeConfig();
	const message = !hasKey
		? "Missing GOOGLE_GENERATIVE_AI_API_KEY. Set it in Netlify env or .env.local."
		: error;

	return new Response(
		JSON.stringify({
			ok: hasKey && !error,
			message,
			modelName: config.modelName,
			maxTokensPerRequest: config.maxTokensPerRequest,
			thinkingLevel: config.thinkingLevel,
			isGemini3Model: config.isGemini3Model,
		}),
		{
			headers: { "Content-Type": "application/json" },
		},
	);
}