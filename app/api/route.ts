import { groupSegmentsByTokenLength } from "@/lib/srt";
import { parseSegment } from "@/lib/client";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

export const dynamic = "force-dynamic";

const MAX_TOKENS_IN_SEGMENT = 700;
const MAX_RETRIES = 3;
const TRANSLATION_DELIMITER = "|||SRT_SEGMENT|||";
const MODEL_NAME = "gemini-2.0-flash";
const TRANSLATION_DELIMITER_CORE = TRANSLATION_DELIMITER.replace(/^\|+|\|+$/g, "");

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

const retrieveTranslation = async (
	text: string,
	language: string,
	expectedSegments: number,
): Promise<string[]> => {
	let retries = MAX_RETRIES;
	while (retries > 0) {
		try {
			const { text: translatedText } = await generateText({
				model: google(MODEL_NAME),
				temperature: 0.2,
				messages: [
					{
						role: "system",
						content:
							`You are an experienced semantic translator specialized in creating SRT subtitles.
							You strictly follow these rules:
							- Preserve meaning, tone, and context naturally.
							- Maintain the original grammatical person (first, second, or third) unless grammatically unavoidable.
							- If the source uses "you" (singular or plural), keep the same grammatical person and formality level.
							- Keep verb conjugations and pronouns aligned with the original speaker perspective.
							- Preserve direct and indirect pronoun meaning and function.
							- Preserve formal/informal register unless grammatically unavoidable.
							- Do not merge, split, reorder, summarize, censor, or omit segments.

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

			if (
				translatedSegments.length !== expectedSegments ||
				translatedSegments.some((segment) => !segment)
			) {
				throw new Error(
					`Unexpected translated output shape. Expected ${expectedSegments} non-empty segments, received ${translatedSegments.length}.`,
				);
			}

			return translatedSegments;
		} catch (error) {
			console.error("Translation error:", error);
			if (retries > 1) {
				console.warn("Retrying translation...");
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			retries--;
			if (retries > 0) continue;
			throw error;
		}
	}

	return [];
};

export async function POST(request: Request) {
	try {
		if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
			return new Response(
				JSON.stringify({
					error:
						"Missing GOOGLE_GENERATIVE_AI_API_KEY. Set it in Netlify env or .env.local.",
				}),
				{ status: 500 },
			);
		}
		const payload = parsePayload(await request.json().catch(() => null));
		if (!payload) {
			return new Response(
				JSON.stringify({ error: "Invalid request. Expected content and language." }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		const { content, language } = payload;
		const segments = content
			.split(/\r\n\r\n|\n\n/)
			.map(parseSegment)
			.filter(
				(segment) =>
					Number.isFinite(segment.id) &&
					Boolean(segment.timestamp?.includes(" --> ")) &&
					Boolean(segment.text?.trim()),
			);

		if (!segments.length) {
			return new Response(
				JSON.stringify({ error: "No valid SRT segments found in request content." }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}

		const groups = groupSegmentsByTokenLength(segments, MAX_TOKENS_IN_SEGMENT);

		let currentIndex = 0;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			async start(controller) {
				try {
					for (const group of groups) {
						const text = group
							.map((segment) => segment.text.trim())
							.join(TRANSLATION_DELIMITER);
						const translatedSegments = await retrieveTranslation(
							text,
							language,
							group.length,
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
					controller.close();
				} catch (streamError) {
					console.error("Error while streaming translation:", streamError);
					controller.error(streamError);
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		console.error("Error during translation:", error);
		return new Response(JSON.stringify({ error: "Error during translation" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}
