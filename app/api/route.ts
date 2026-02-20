import { groupSegmentsByTokenLength } from "@/lib/srt";
import { parseSegment } from "@/lib/client";
import { resolveTranslationRuntimeConfig } from "@/lib/translation-config";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

export const dynamic = "force-dynamic";
// Platforms that support this can allow longer-running batches.
export const maxDuration = 300;

const MAX_RETRIES = 3;
const TRANSLATION_DELIMITER = "|||SRT_SEGMENT|||";
const MODEL_CALL_TIMEOUT_MS = 55_000;
const TRANSLATION_DELIMITER_CORE = TRANSLATION_DELIMITER.replace(/^\|+|\|+$/g, "");
const SEGMENT_BLOCK_SPLIT_REGEX = /\r?\n\s*\r?\n/;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTranslatedSegments(rawText: string): string[] {
	const normalizedText = rawText.replace(/\r\n/g, "\n").trim();
	const permissiveDelimiter = new RegExp(
		`["'“”‘’]?\\|{3}\\s*${escapeRegExp(TRANSLATION_DELIMITER_CORE)}\\s*\\|{3}["'“”‘’]?`,
		"g",
	);

	// Normalize harmless delimiter formatting drift before strict split/count checks.
	const delimiterNormalizedText = normalizedText.replace(
		permissiveDelimiter,
		TRANSLATION_DELIMITER,
	);

	return delimiterNormalizedText
		.split(TRANSLATION_DELIMITER)
		.map((segment) => segment.trim());
}

function parsePayload(payload: unknown): { content: string; language: string } | null {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const { content, language } = payload as Record<string, unknown>;
	if (typeof content !== "string" || typeof language !== "string") {
		return null;
	}

	if (!content.trim() || !language.trim()) {
		return null;
	}

	return { content, language: language.trim() };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorLog(error: unknown): Record<string, unknown> {
	if (!(error && typeof error === "object")) {
		return { message: String(error) };
	}

	const errorRecord = error as Record<string, unknown>;
	const cause =
		errorRecord.cause && typeof errorRecord.cause === "object"
			? (errorRecord.cause as Record<string, unknown>)
			: undefined;

	const details: Record<string, unknown> = {
		name: typeof errorRecord.name === "string" ? errorRecord.name : "UnknownError",
		message:
			typeof errorRecord.message === "string"
				? errorRecord.message
				: String(error),
	};

	const statusCode =
		typeof errorRecord.statusCode === "number"
			? errorRecord.statusCode
			: typeof cause?.statusCode === "number"
				? cause.statusCode
				: undefined;
	if (statusCode !== undefined) {
		details.statusCode = statusCode;
	}

	const code =
		typeof errorRecord.code === "string"
			? errorRecord.code
			: typeof cause?.code === "string"
				? cause.code
				: undefined;
	if (code !== undefined) {
		details.code = code;
	}

	return details;
}

type TranslationRequestContext = {
	runId: string;
	batchLabel: string;
	groupIndex: number;
	totalGroups: number;
	modelName: string;
	thinkingLevel: "minimal" | "low" | "medium" | "high";
	isGemini3Model: boolean;
};

const retrieveTranslation = async (
	text: string,
	language: string,
	expectedSegments: number,
	context: TranslationRequestContext,
): Promise<string[]> => {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
		const attemptStartedAt = Date.now();
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), MODEL_CALL_TIMEOUT_MS);

		console.info(
			`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} attempt ${attempt}/${MAX_RETRIES} started`,
			{
				inputChars: text.length,
				expectedSegments,
				model: context.modelName,
				thinkingLevel: context.thinkingLevel,
				isGemini3Model: context.isGemini3Model,
			},
		);

		try {
			const { text: translatedText } = await generateText({
				model: google(context.modelName),
				...(context.isGemini3Model
					? {
							providerOptions: {
								google: {
									thinkingConfig: {
										thinkingLevel: context.thinkingLevel,
									},
								},
							},
						}
					: {}),
				abortSignal: abortController.signal,
				messages: [
					{
						role: "system",
						content:
							`You are an experienced semantic translator specialized in creating SRT subtitles.
							You strictly follow these rules:
							- Preserve meaning, tone, context, and intent naturally.
							- Prioritize idiomatic, native phrasing in the target language over literal word-by-word translation.
							- Avoid calques and unnatural literal constructions from the source language.
							- Keep dialogue phrasing conversational and subtitle-appropriate.
							- Maintain the original grammatical person (first, second, or third) unless grammatically unavoidable.
							- If the source uses "you" (singular or plural), keep the same grammatical person and formality level.
							- Keep verb conjugations and pronouns aligned with the original speaker perspective.
							- Preserve direct and indirect pronoun meaning and function.
							- Preserve formal/informal register unless grammatically unavoidable.
							- Prefer natural collocations and common expressions used by native speakers.
							- If a phrase has a known idiomatic equivalent in the target language, use that equivalent instead of a literal rendering.
							- Do not merge, split, reorder, summarize, censor, or omit segments.
							- Preserve internal line breaks inside each subtitle segment.
							- If a segment has multiple lines (for example, dialogue turns), keep the same line order and line-break structure.
							- Preserve punctuation style and emphasis (including dashes for dialogue turns).

							The input text contains ${expectedSegments} subtitle segments separated by "${TRANSLATION_DELIMITER}".
							Return exactly ${expectedSegments} translated segments in the same order, separated only by "${TRANSLATION_DELIMITER}".
							Output only translated segment text.
							Never add numbering, timestamps, markdown, code fences, or explanations.
							Never include "${TRANSLATION_DELIMITER}" inside any translated segment.`,
					},
					{
						role: "user",
						content: `Translate to ${language}: ${text}`,
					},
				],
			});

			const translatedSegments = splitTranslatedSegments(translatedText);

			if (translatedSegments.length !== expectedSegments) {
				throw new Error(
					`Unexpected translated output shape. Expected ${expectedSegments} segments, received ${translatedSegments.length}.`,
				);
			}

			console.info(
				`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} attempt ${attempt}/${MAX_RETRIES} succeeded`,
				{
					durationMs: Date.now() - attemptStartedAt,
					outputChars: translatedText.length,
					outputSegments: translatedSegments.length,
				},
			);

			return translatedSegments;
		} catch (error) {
			console.error(
				`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} attempt ${attempt}/${MAX_RETRIES} failed`,
				{
					durationMs: Date.now() - attemptStartedAt,
					...toErrorLog(error),
				},
			);
			if (attempt < MAX_RETRIES) {
				console.warn(
					`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} retrying in 1000ms`,
				);
				await sleep(1000);
				continue;
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	return [];
};

export async function POST(request: Request) {
	const incomingRunId = request.headers.get("x-translation-run-id")?.trim();
	const runId = incomingRunId || crypto.randomUUID();
	const requestNumber = Number.parseInt(
		request.headers.get("x-translation-request-number") ?? "",
		10,
	);
	const totalRequests = Number.parseInt(
		request.headers.get("x-translation-total-requests") ?? "",
		10,
	);
	const batchLabel =
		Number.isFinite(requestNumber) && requestNumber > 0
			? `${requestNumber}${Number.isFinite(totalRequests) && totalRequests > 0 ? `/${totalRequests}` : ""}`
			: "unknown";
	const batchStartedAt = Date.now();
	const { config: runtimeConfig, error: runtimeConfigError } =
		resolveTranslationRuntimeConfig();

	try {
		if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
			return new Response(
				JSON.stringify({
					error:
						"Missing GOOGLE_GENERATIVE_AI_API_KEY. Set it in Netlify env or .env.local.",
					runId,
				}),
				{
					status: 500,
					headers: {
						"Content-Type": "application/json",
						"x-translation-run-id": runId,
					},
				},
			);
		}
		if (runtimeConfigError) {
			return new Response(
				JSON.stringify({
					error: runtimeConfigError,
					runId,
				}),
				{
					status: 500,
					headers: {
						"Content-Type": "application/json",
						"x-translation-run-id": runId,
					},
				},
			);
		}
		const payload = parsePayload(await request.json().catch(() => null));
		if (!payload) {
			return new Response(
				JSON.stringify({
					error: "Invalid request. Expected content and language.",
					runId,
				}),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
						"x-translation-run-id": runId,
					},
				},
			);
		}

		const { content, language } = payload;
		console.info(`[translate][${runId}] Batch ${batchLabel} accepted`, {
			model: runtimeConfig.modelName,
			language,
			contentChars: content.length,
			timeoutMs: MODEL_CALL_TIMEOUT_MS,
			thinkingLevel: runtimeConfig.thinkingLevel,
			isGemini3Model: runtimeConfig.isGemini3Model,
			maxTokensPerRequest: runtimeConfig.maxTokensPerRequest,
		});

		const segments = content
			.split(SEGMENT_BLOCK_SPLIT_REGEX)
			.map((segment) => segment.trim())
			.filter(Boolean)
			.map(parseSegment)
			.map((segment, index) => ({
				...segment,
				id: Number.isFinite(segment.id) && segment.id > 0 ? segment.id : index + 1,
			}));

		if (!segments.length) {
			return new Response(
				JSON.stringify({
					error: "No valid SRT segments found in request content.",
					runId,
				}),
				{
					status: 400,
					headers: {
						"Content-Type": "application/json",
						"x-translation-run-id": runId,
					},
				},
			);
		}

		const groups = groupSegmentsByTokenLength(
			segments,
			runtimeConfig.maxTokensPerRequest,
		);
		console.info(`[translate][${runId}] Batch ${batchLabel} parsed`, {
			segments: segments.length,
			groups: groups.length,
			maxTokensPerRequest: runtimeConfig.maxTokensPerRequest,
		});

		let currentIndex = 0;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			async start(controller) {
				const streamStartedAt = Date.now();
				try {
					for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
						const group = groups[groupIndex];
						const text = group.map((segment) => segment.text).join(TRANSLATION_DELIMITER);
						const translatedSegments = await retrieveTranslation(
							text,
							language,
							group.length,
							{
								runId,
								batchLabel,
								groupIndex: groupIndex + 1,
								totalGroups: groups.length,
								modelName: runtimeConfig.modelName,
								thinkingLevel: runtimeConfig.thinkingLevel,
								isGemini3Model: runtimeConfig.isGemini3Model,
							},
						);

						for (const segment of translatedSegments) {
							const originalSegment = segments[currentIndex];
							currentIndex += 1;
							if (!originalSegment) {
								continue;
							}

							const srt = `${originalSegment.id}\n${originalSegment.timestamp}\n${segment.trim()}\n\n`;
							controller.enqueue(encoder.encode(srt));
						}
					}

					console.info(`[translate][${runId}] Batch ${batchLabel} streamed`, {
						durationMs: Date.now() - streamStartedAt,
						outputSegments: currentIndex,
					});
					controller.close();
				} catch (streamError) {
					console.error(`[translate][${runId}] Batch ${batchLabel} stream error`, {
						...toErrorLog(streamError),
					});
					controller.error(streamError);
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
				"x-translation-run-id": runId,
			},
		});
	} catch (error) {
		console.error(`[translate][${runId}] Batch ${batchLabel} failed`, {
			durationMs: Date.now() - batchStartedAt,
			...toErrorLog(error),
		});
		return new Response(JSON.stringify({ error: "Error during translation", runId }), {
			status: 500,
			headers: {
				"Content-Type": "application/json",
				"x-translation-run-id": runId,
			},
		});
	}
}
