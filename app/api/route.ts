import { parseSegment } from "@/lib/client";
import {
	applyIrreducibleBlockPolicy,
	attachTranslationErrorInfo,
	classifyFinishReason,
	classifyTranslationError,
	getTranslationErrorInfo,
	translationErrorCategoryToCode,
} from "@/lib/content-block-handler";
import { groupSegmentsByTokenLength } from "@/lib/srt";
import { resolveTranslationRuntimeConfig } from "@/lib/translation-config";
import type {
	ProhibitedContentPolicy,
	Segment,
	TranslatedSegmentResult,
	TranslationErrorCategory,
	TranslationErrorInfo,
	TranslationGroupResult,
} from "@/types";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

export const dynamic = "force-dynamic";
// Platforms that support this can allow longer-running batches.
export const maxDuration = 300;

const MAX_RETRIES = 3;
const MODEL_CALL_TIMEOUT_MS = 55_000;
const SEGMENT_BLOCK_SPLIT_REGEX = /\r?\n\s*\r?\n/;
const BASE_SERVER_BACKOFF_DELAY_MS = 1_000;
const MAX_SERVER_BACKOFF_DELAY_MS = 8_000;

type TranslationRequestContext = {
	runId: string;
	batchLabel: string;
	groupIndex: number;
	totalGroups: number;
	modelName: string;
	thinkingLevel: "minimal" | "low" | "medium" | "high";
	isGemini3Model: boolean;
};

type TranslationFallbackConfig = {
	policy: ProhibitedContentPolicy;
	placeholder: string;
	maxSplitDepth: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitTranslatedSegments(rawText: string, delimiter: string): string[] {
	const delimiterCore = delimiter.replace(/^\|+|\|+$/g, "");
	const normalizedText = rawText.replace(/\r\n/g, "\n").trim();
	const permissiveDelimiter = new RegExp(
		`["'“”‘’]?\\|{3}\\s*${escapeRegExp(delimiterCore)}\\s*\\|{3}["'“”‘’]?`,
		"g",
	);

	// Normalize harmless delimiter formatting drift before strict split/count checks.
	const delimiterNormalizedText = normalizedText.replace(
		permissiveDelimiter,
		delimiter,
	);

	return delimiterNormalizedText
		.split(delimiter)
		.map((segment) => segment.trim());
}

function normalizeTranslatedSegmentCount(
	segments: string[],
	expectedSegments: number,
): string[] {
	if (segments.length === expectedSegments) {
		return segments;
	}

	// Some model responses include harmless leading/trailing delimiters.
	const withoutBoundaryEmpties = [...segments];
	while (withoutBoundaryEmpties[0]?.length === 0) {
		withoutBoundaryEmpties.shift();
	}
	while (withoutBoundaryEmpties[withoutBoundaryEmpties.length - 1]?.length === 0) {
		withoutBoundaryEmpties.pop();
	}

	if (withoutBoundaryEmpties.length === expectedSegments) {
		return withoutBoundaryEmpties;
	}

	const withoutAllEmpties = withoutBoundaryEmpties.filter(
		(segment) => segment.length > 0,
	);
	if (withoutAllEmpties.length === expectedSegments) {
		return withoutAllEmpties;
	}

	return segments;
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

function getServerRetryDelayMs(attempt: number): number {
	const exponentialDelay = BASE_SERVER_BACKOFF_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.floor(Math.random() * 250);
	return Math.min(MAX_SERVER_BACKOFF_DELAY_MS, exponentialDelay + jitter);
}

function getMaxAttemptsForCategory(category: TranslationErrorCategory): number {
	if (category === "segment_mismatch" || category === "unknown") {
		return 2;
	}
	return MAX_RETRIES;
}

function extractProviderResponseIdFromResult(response: unknown): string | undefined {
	if (!isRecord(response)) {
		return undefined;
	}

	const directId = response.id;
	if (typeof directId === "string") {
		return directId;
	}

	const responseMetadata = response.response;
	if (!isRecord(responseMetadata)) {
		return undefined;
	}

	return typeof responseMetadata.id === "string" ? responseMetadata.id : undefined;
}

function buildErrorMessage(info: TranslationErrorInfo): string {
	switch (info.category) {
		case "prohibited_content":
		case "safety_filter":
		case "content_filter":
		case "prompt_blocked":
			return "Translation blocked due to content restrictions.";
		case "timeout":
			return "Translation request timed out. Please retry.";
		case "segment_mismatch":
			return "Translation output was invalid. Please retry.";
		case "transient":
		case "network":
			return "Translation provider is temporarily unavailable. Please retry.";
		case "unknown":
		default:
			return "Error during translation";
	}
}

function toJsonResponse(
	body: Record<string, unknown>,
	status: number,
	runId: string,
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"x-translation-run-id": runId,
		},
	});
}

function mergeGroupResults(
	leftResult: TranslationGroupResult,
	rightResult: TranslationGroupResult,
	depth: number,
): TranslationGroupResult {
	const blockedSegmentIds = Array.from(
		new Set([...leftResult.blockedSegmentIds, ...rightResult.blockedSegmentIds]),
	);
	const blockedReasons = Array.from(
		new Set([...leftResult.blockedReasons, ...rightResult.blockedReasons]),
	);

	return {
		segments: [...leftResult.segments, ...rightResult.segments],
		hasBlockedSegments: blockedSegmentIds.length > 0,
		blockedSegmentIds,
		blockedReasons,
		splitDepth: Math.max(depth, leftResult.splitDepth, rightResult.splitDepth),
	};
}

const retrieveTranslation = async (
	segments: Segment[],
	language: string,
	context: TranslationRequestContext,
	depth: number,
): Promise<string[]> => {
	const expectedSegments = segments.length;
	const segmentIds = segments.map((segment) => segment.id);

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
		const attemptStartedAt = Date.now();
		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), MODEL_CALL_TIMEOUT_MS);
		const translationDelimiter = `|||SRT_SEGMENT_${crypto
			.randomUUID()
			.replace(/-/g, "")}|||`;
		const text = segments.map((segment) => segment.text).join(translationDelimiter);

		console.info(
			`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} attempt ${attempt}/${MAX_RETRIES} started`,
			{
				inputChars: text.length,
				expectedSegments,
				model: context.modelName,
				thinkingLevel: context.thinkingLevel,
				isGemini3Model: context.isGemini3Model,
				splitDepth: depth,
				segmentIds,
			},
		);

		try {
			const result = await generateText({
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

							The input text contains ${expectedSegments} subtitle segments separated by "${translationDelimiter}".
							Return exactly ${expectedSegments} translated segments in the same order, separated only by "${translationDelimiter}".
							Output only translated segment text.
							Never add numbering, timestamps, markdown, code fences, or explanations.
							Never include "${translationDelimiter}" inside any translated segment.`,
					},
					{
						role: "user",
						content: `Translate to ${language}: ${text}`,
					},
				],
			});

			const providerResponseId = extractProviderResponseIdFromResult(
				(result as { response?: unknown }).response,
			);
			const finishReasonInfo = classifyFinishReason(
				typeof result.finishReason === "string" ? result.finishReason : undefined,
				providerResponseId,
			);
			if (finishReasonInfo) {
				console.warn(
					`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} finishReason non-normal`,
					{
						splitDepth: depth,
						finishReason: finishReasonInfo.blockReason,
						segmentCount: expectedSegments,
						segmentIds,
						providerResponseId: finishReasonInfo.providerResponseId,
					},
				);
				throw attachTranslationErrorInfo(
					new Error(`Blocked finishReason: ${finishReasonInfo.blockReason}`),
					finishReasonInfo,
				);
			}

			if (!result.text || !result.text.trim()) {
				throw new Error("Model returned empty translation output.");
			}

			const translatedSegments = normalizeTranslatedSegmentCount(
				splitTranslatedSegments(result.text, translationDelimiter),
				expectedSegments,
			);

			if (translatedSegments.length !== expectedSegments) {
				throw new Error(
					`Unexpected translated output shape. Expected ${expectedSegments} segments, received ${translatedSegments.length}.`,
				);
			}

			console.info(
				`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} attempt ${attempt}/${MAX_RETRIES} succeeded`,
				{
					durationMs: Date.now() - attemptStartedAt,
					outputChars: result.text.length,
					outputSegments: translatedSegments.length,
					splitDepth: depth,
				},
			);

			return translatedSegments;
		} catch (error) {
			const classified = classifyTranslationError(error);
			console.info(`[translate][${context.runId}] error classified`, {
				batchLabel: context.batchLabel,
				groupIndex: context.groupIndex,
				category: classified.category,
				retryable: classified.retryable,
				splittable: classified.splittable,
				blockReason: classified.blockReason,
				providerResponseId: classified.providerResponseId,
			});

			console.error(
				`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} attempt ${attempt}/${MAX_RETRIES} failed`,
				{
					durationMs: Date.now() - attemptStartedAt,
					splitDepth: depth,
					category: classified.category,
					...toErrorLog(error),
				},
			);

			if (!classified.retryable) {
				throw attachTranslationErrorInfo(error, classified);
			}

			const maxAttemptsForCategory = getMaxAttemptsForCategory(classified.category);
			if (attempt >= maxAttemptsForCategory) {
				throw attachTranslationErrorInfo(error, classified);
			}

			const retryDelayMs = getServerRetryDelayMs(attempt);
			console.warn(
				`[translate][${context.runId}] Batch ${context.batchLabel} group ${context.groupIndex}/${context.totalGroups} retrying in ${retryDelayMs}ms`,
				{
					category: classified.category,
					attempt,
					maxAttemptsForCategory,
				},
			);
			await sleep(retryDelayMs);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	throw new Error("Translation failed after retries.");
};

const retrieveTranslationWithFallback = async (
	segments: Segment[],
	language: string,
	context: TranslationRequestContext,
	fallbackConfig: TranslationFallbackConfig,
	depth = 0,
): Promise<TranslationGroupResult> => {
	const startedAt = Date.now();
	try {
		const translated = await retrieveTranslation(segments, language, context, depth);
		const translatedSegments: TranslatedSegmentResult[] = translated.map(
			(segmentText, index) => ({
				text: segmentText,
				blocked: false,
				originalSegmentId: segments[index]?.id ?? index + 1,
			}),
		);
		return {
			segments: translatedSegments,
			hasBlockedSegments: false,
			blockedSegmentIds: [],
			blockedReasons: [],
			splitDepth: depth,
		};
	} catch (error) {
		const classified = getTranslationErrorInfo(error) ?? classifyTranslationError(error);
		const segmentIds = segments.map((segment) => segment.id);

		console.info(`[translate][${context.runId}] error classified`, {
			batchLabel: context.batchLabel,
			groupIndex: context.groupIndex,
			category: classified.category,
			retryable: classified.retryable,
			splittable: classified.splittable,
			blockReason: classified.blockReason,
			providerResponseId: classified.providerResponseId,
			splitDepth: depth,
		});

		if (!classified.splittable) {
			throw attachTranslationErrorInfo(error, classified);
		}

		console.warn(
			`[translate][${context.runId}] content blocked`,
			{
				batchLabel: context.batchLabel,
				groupIndex: context.groupIndex,
				category: classified.category,
				blockReason: classified.blockReason,
				segmentIds,
				segmentCount: segments.length,
				splitDepth: depth,
				providerResponseId: classified.providerResponseId,
			},
		);

		if (segments.length === 1) {
			const blockedSegment = applyIrreducibleBlockPolicy(
				segments[0],
				fallbackConfig.policy,
				fallbackConfig.placeholder,
				classified.blockReason,
			);
			console.warn(`[translate][${context.runId}] irreducible block`, {
				batchLabel: context.batchLabel,
				groupIndex: context.groupIndex,
				segmentId: segments[0].id,
				category: classified.category,
				blockReason: classified.blockReason,
				policy: fallbackConfig.policy,
				originalTextLength: segments[0].text.length,
				splitDepth: depth,
			});
			return {
				segments: [blockedSegment],
				hasBlockedSegments: true,
				blockedSegmentIds: [segments[0].id],
				blockedReasons: classified.blockReason ? [classified.blockReason] : [],
				splitDepth: depth,
			};
		}

		if (depth >= fallbackConfig.maxSplitDepth) {
			console.warn(`[translate][${context.runId}] split depth limit reached`, {
				batchLabel: context.batchLabel,
				groupIndex: context.groupIndex,
				maxSplitDepth: fallbackConfig.maxSplitDepth,
				segmentCount: segments.length,
				segmentIds,
				category: classified.category,
				blockReason: classified.blockReason,
			});
			const blockedSegments = segments.map((segment) =>
				applyIrreducibleBlockPolicy(
					segment,
					fallbackConfig.policy,
					fallbackConfig.placeholder,
					classified.blockReason,
				),
			);
			return {
				segments: blockedSegments,
				hasBlockedSegments: true,
				blockedSegmentIds: segmentIds,
				blockedReasons: classified.blockReason ? [classified.blockReason] : [],
				splitDepth: depth,
			};
		}

		const middleIndex = Math.ceil(segments.length / 2);
		const leftSegments = segments.slice(0, middleIndex);
		const rightSegments = segments.slice(middleIndex);

		console.info(`[translate][${context.runId}] splitting group`, {
			batchLabel: context.batchLabel,
			groupIndex: context.groupIndex,
			originalSize: segments.length,
			leftSize: leftSegments.length,
			rightSize: rightSegments.length,
			depth,
			segmentIds,
		});

		const leftResult = await retrieveTranslationWithFallback(
			leftSegments,
			language,
			context,
			fallbackConfig,
			depth + 1,
		);
		const rightResult = await retrieveTranslationWithFallback(
			rightSegments,
			language,
			context,
			fallbackConfig,
			depth + 1,
		);

		const merged = mergeGroupResults(leftResult, rightResult, depth);
		if (depth === 0) {
			console.info(`[translate][${context.runId}] split fallback complete`, {
				batchLabel: context.batchLabel,
				groupIndex: context.groupIndex,
				totalSegments: segments.length,
				blockedCount: merged.blockedSegmentIds.length,
				splitDepth: merged.splitDepth,
				durationMs: Date.now() - startedAt,
			});
		}
		return merged;
	}
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
			return toJsonResponse(
				{
					error:
						"Missing GOOGLE_GENERATIVE_AI_API_KEY. Set it in Netlify env or .env.local.",
					code: "CONFIG_ERROR",
					runId,
				},
				500,
				runId,
			);
		}
		if (runtimeConfigError) {
			return toJsonResponse(
				{
					error: runtimeConfigError,
					code: "CONFIG_ERROR",
					runId,
				},
				500,
				runId,
			);
		}

		const payload = parsePayload(await request.json().catch(() => null));
		if (!payload) {
			return toJsonResponse(
				{
					error: "Invalid request. Expected content and language.",
					code: "INVALID_REQUEST",
					runId,
				},
				400,
				runId,
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
			prohibitedContentPolicy: runtimeConfig.prohibitedContentPolicy,
			maxSplitDepth: runtimeConfig.maxSplitDepth,
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
			return toJsonResponse(
				{
					error: "No valid SRT segments found in request content.",
					code: "INVALID_REQUEST",
					runId,
				},
				400,
				runId,
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

		const translatedBlocks: string[] = [];
		const blockedSegmentIds: number[] = [];
		const blockedReasons = new Set<string>();
		let outputSegments = 0;

		for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
			const group = groups[groupIndex];
			const groupResult = await retrieveTranslationWithFallback(
				group,
				language,
				{
					runId,
					batchLabel,
					groupIndex: groupIndex + 1,
					totalGroups: groups.length,
					modelName: runtimeConfig.modelName,
					thinkingLevel: runtimeConfig.thinkingLevel,
					isGemini3Model: runtimeConfig.isGemini3Model,
				},
				{
					policy: runtimeConfig.prohibitedContentPolicy,
					placeholder: runtimeConfig.prohibitedContentPlaceholder,
					maxSplitDepth: runtimeConfig.maxSplitDepth,
				},
			);

			if (groupResult.segments.length !== group.length) {
				throw new Error(
					`Unexpected translated output shape. Expected ${group.length} segments, received ${groupResult.segments.length}.`,
				);
			}

			for (let segmentIndex = 0; segmentIndex < group.length; segmentIndex += 1) {
				const originalSegment = group[segmentIndex];
				const translatedSegment = groupResult.segments[segmentIndex];
				const translatedText = translatedSegment?.text?.trim() ?? "";
				translatedBlocks.push(
					`${originalSegment.id}\n${originalSegment.timestamp}\n${translatedText}\n\n`,
				);
				outputSegments += 1;

				if (translatedSegment?.blocked) {
					blockedSegmentIds.push(originalSegment.id);
				}
				if (translatedSegment?.blockReason) {
					blockedReasons.add(translatedSegment.blockReason);
				}
			}

			if (groupResult.hasBlockedSegments) {
				console.info(`[translate][${runId}] batch partial success`, {
					batchLabel,
					groupIndex: groupIndex + 1,
					totalSegments: group.length,
					translatedCount:
						group.length - groupResult.blockedSegmentIds.length,
					blockedCount: groupResult.blockedSegmentIds.length,
					blockedSegmentIds: groupResult.blockedSegmentIds,
					blockReasons: groupResult.blockedReasons,
				});
			}
		}

		if (outputSegments !== segments.length) {
			throw new Error(
				`Unexpected translated output shape. Expected ${segments.length} segments, received ${outputSegments}.`,
			);
		}

		const uniqueBlockedSegmentIds = Array.from(new Set(blockedSegmentIds));
		const translationStatus = uniqueBlockedSegmentIds.length > 0 ? "partial" : "complete";
		const headers: Record<string, string> = {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"x-translation-run-id": runId,
			"x-translation-status": translationStatus,
		};

		if (uniqueBlockedSegmentIds.length > 0) {
			headers["x-translation-blocked-segments"] = uniqueBlockedSegmentIds.join(",");
		}
		if (blockedReasons.size > 0) {
			headers["x-translation-blocked-reasons"] = Array.from(blockedReasons).join(",");
		}

		console.info(`[translate][${runId}] Batch ${batchLabel} completed`, {
			durationMs: Date.now() - batchStartedAt,
			outputSegments,
			status: translationStatus,
			blockedCount: uniqueBlockedSegmentIds.length,
			blockedSegmentIds: uniqueBlockedSegmentIds,
			blockReasons: Array.from(blockedReasons),
		});

		return new Response(translatedBlocks.join(""), {
			headers,
		});
	} catch (error) {
		const classified = getTranslationErrorInfo(error) ?? classifyTranslationError(error);
		const code = translationErrorCategoryToCode(classified.category);
		const status = classified.category === "timeout" ? 504 : 500;
		const responseBody: Record<string, unknown> = {
			error: buildErrorMessage(classified),
			code,
			runId,
		};
		if (classified.blockReason) {
			responseBody.blockReasons = [classified.blockReason];
		}

		console.error(`[translate][${runId}] Batch ${batchLabel} failed`, {
			durationMs: Date.now() - batchStartedAt,
			category: classified.category,
			retryable: classified.retryable,
			splittable: classified.splittable,
			blockReason: classified.blockReason,
			providerResponseId: classified.providerResponseId,
			...toErrorLog(error),
		});

		return toJsonResponse(responseBody, status, runId);
	}
}
