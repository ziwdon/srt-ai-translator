import { groupSegmentsByTokenLength } from "@/lib/srt";
import { parseSegment } from "@/lib/client";
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

export const dynamic = "force-dynamic";

const MAX_TOKENS_IN_SEGMENT = 700;

const retrieveTranslation = async (text: string, language: string) => {
	let retries = 3;
	while (retries > 0) {
		try {
			const { text: translatedText } = await generateText({
				model: google("gemini-2.0-flash"),
				messages: [
					{
						role: "system",
						content:
							`You are an experienced semantic translator, specialized in creating SRT files. 
							You strictly abide by the following rules: 
							
							Maintain the original grammatical person (first, second, or third person) exactly as in the source language. Do not shift between persons unless grammatically unavoidable.  

							If the source text uses "you" (singular or plural), ensure the translation keeps the same grammatical person and formality level. Avoid translating second-person sentences into third-person ones unless grammatically unavoidable. 
							
							Ensure verb conjugations and pronouns align perfectly with the original speaker's perspective. Do not modify them to match another language's common conventions. 

							Pay close attention to direct and indirect pronouns, ensuring they preserve their meaning and grammatical function. 

							If the original text uses informal or formal address, reflect this precisely in the translation without altering the intended register. 
							
							Separate translation segments with the '|' symbol`,
					},
					{
						role: "user",
						content: `Translate the following text to ${language} while strictly abiding by the rules: ${text}`,
					},
				],
			});

			return translatedText;
		} catch (error) {
			console.error("Translation error:", error);
			if (retries > 1) {
				console.warn("Retrying translation...");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				retries--;
				continue;
			}
			throw error;
		}
	}
};

export async function POST(request: Request) {
	try {
		const { content, language } = await request.json();
		const segments = content.split(/\r\n\r\n|\n\n/).map(parseSegment);
		const groups = groupSegmentsByTokenLength(segments, MAX_TOKENS_IN_SEGMENT);

		let currentIndex = 0;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			async start(controller) {
				for (const group of groups) {
					const text = group.map((segment) => segment.text).join("|");
					const translatedText = await retrieveTranslation(text, language);
					if (!translatedText) continue;

					const translatedSegments = translatedText.split("|");
					for (const segment of translatedSegments) {
						if (segment.trim()) {
							const originalSegment = segments[currentIndex];
							const srt = `${++currentIndex}\n${originalSegment?.timestamp || ""}\n${segment.trim()}\n\n`;
							controller.enqueue(encoder.encode(srt));
						}
					}
				}
				controller.close();
			},
		});

		return new Response(stream);
	} catch (error) {
		console.error("Error during translation:", error);
		return new Response(JSON.stringify({ error: "Error during translation" }), {
			status: 500,
		});
	}
}
