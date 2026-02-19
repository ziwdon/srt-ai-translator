"use client";

import React from "react";
import Link from "next/link";
import { libre, roaldDahl } from "@/fonts";

import Form from "@/components/Form";
import Timestamp from "@/components/Timestamp";

import type { Chunk, Segment } from "@/types";
import { parseSegment, parseTimestamp } from "@/lib/client";
import { groupSegmentsByTokenLength } from "@/lib/srt";

function classNames(...classes: string[]) {
	return classes.filter(Boolean).join(" ");
}

const MAX_TOKENS_PER_TRANSLATION_REQUEST = 700;

function serializeSegment(segment: Segment): string {
	return `${segment.id}\n${segment.timestamp}\n${segment.text}`;
}

const triggerFileDownload = (filename: string, content: string) => {
	const element = document.createElement("a");
	const file = new Blob([content], { type: "text/plain" });
	const fileUrl = URL.createObjectURL(file);
	element.href = fileUrl;
	element.download = filename;
	document.body.appendChild(element);
	element.click();
	element.remove();
	URL.revokeObjectURL(fileUrl);
};

function Translating({ chunks }: { chunks: Chunk[] }) {
	return (
		<div className="flex gap-y-2 flex-col-reverse">
			{chunks.map((chunk) => (
				<Timestamp key={`${chunk.index}-${chunk.start}`} {...chunk} />
			))}
		</div>
	);
}

export default function Home() {
	const [status, setStatus] = React.useState<"idle" | "busy" | "done">("idle");
	const [translatedChunks, setTranslatedChunks] = React.useState<Chunk[]>([]);
	const [originalChunks, setOriginalChunks] = React.useState<Chunk[]>([]);
	const [configOk, setConfigOk] = React.useState<boolean | null>(null);
	const [configMessage, setConfigMessage] = React.useState<string | null>(null);

	React.useEffect(() => {
		(async () => {
			try {
				const res = await fetch("/api/config");
				const data = await res.json();
				if (data?.ok) {
					setConfigOk(true);
				} else {
					setConfigOk(false);
					setConfigMessage(
						data?.message ||
							"Missing GOOGLE_GENERATIVE_AI_API_KEY. Set it in Netlify env or .env.local.",
					);
				}
			} catch {
				setConfigOk(false);
				setConfigMessage("Unable to verify configuration.");
			}
		})();
	}, []);

	async function handleStream(response: Response): Promise<{
		content: string;
		translatedSegmentCount: number;
	}> {
		const data = response.body;
		if (!data) {
			throw new Error("Translation response body is missing.");
		}

		let content = "";
		let translatedSegmentCount = 0;
		let pending = "";
		const reader = data.getReader();
		const decoder = new TextDecoder();

		const appendChunkToPreview = (incomingText: string) => {
			const blocks = incomingText.split(/\r?\n\r?\n/);
			pending = blocks.pop() ?? "";
			const parsedChunks: Chunk[] = [];

			for (const block of blocks) {
				const normalizedBlock = block.trim();
				if (!normalizedBlock) {
					continue;
				}

				translatedSegmentCount += 1;
				const { id, timestamp, text } = parseSegment(normalizedBlock);
				if (!Number.isFinite(id) || !timestamp.includes(" --> ") || !text.trim()) {
					continue;
				}

				const { start, end } = parseTimestamp(timestamp);
				parsedChunks.push({ index: id.toString(), start, end, text });
			}

			if (parsedChunks.length) {
				setTranslatedChunks((prev) => [...prev, ...parsedChunks]);
			}
		};

		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			const chunk = decoder.decode(value, { stream: true });
			if (!chunk) {
				continue;
			}

			content += chunk;
			appendChunkToPreview(pending + chunk);
		}

		const finalChunk = decoder.decode();
		if (finalChunk) {
			content += finalChunk;
			appendChunkToPreview(pending + finalChunk);
		}

		const trailingBlock = pending.trim();
		if (trailingBlock) {
			translatedSegmentCount += 1;
			const { id, timestamp, text } = parseSegment(trailingBlock);
			if (Number.isFinite(id) && timestamp.includes(" --> ") && text.trim()) {
				const { start, end } = parseTimestamp(timestamp);
				setTranslatedChunks((prev) => [
					...prev,
					{ index: id.toString(), start, end, text },
				]);
			}
		}

		return { content, translatedSegmentCount };
	}

	async function handleSubmit(content: string, language: string, filename: string) {
		try {
			if (!content) {
				console.error("No content provided");
				return;
			}

			setStatus("busy");
			// Reset previous state
			setTranslatedChunks([]);
			setOriginalChunks([]);

			const segments = content.split(/\r\n\r\n|\n\n/).filter((segment) => {
				const lines = segment.split(/\r\n|\n/);
				const id = Number.parseInt(lines[0], 10);
				return (
					lines.length >= 3 && // Must have at least id, timestamp, and text
					!Number.isNaN(id) && // First line must be a number
					lines[1].includes(" --> ")
				); // Second line must be a timestamp
			});

			if (!segments.length) {
				setStatus("idle");
				alert("Invalid SRT file format. Please check your file.");
				return;
			}

			let originalSegments: Segment[] = [];
			try {
				originalSegments = segments
					.map(parseSegment)
					.filter(
						(segment) =>
							Number.isFinite(segment.id) &&
							Boolean(segment.timestamp?.includes(" --> ")) &&
							Boolean(segment.text?.trim()),
					);
				if (!originalSegments.length) {
					throw new Error("No valid subtitle segments found.");
				}
				setOriginalChunks(
					originalSegments.map((seg) => ({
						index: seg.id.toString(),
						start: seg.timestamp.split(" --> ")[0],
						end: seg.timestamp.split(" --> ")[1],
						text: seg.text,
					})),
				);
			} catch (error) {
				setStatus("idle");
				alert("Error parsing SRT file. Please check the file format.");
				console.error("Parsing error:", error);
				return;
			}

			const requestGroups = groupSegmentsByTokenLength(
				originalSegments,
				MAX_TOKENS_PER_TRANSLATION_REQUEST,
			);

			let translatedContent = "";
			let translatedSegmentCount = 0;

			for (const requestGroup of requestGroups) {
				const requestContent = requestGroup.map(serializeSegment).join("\n\n");
				const response = await fetch("/api", {
					method: "POST",
					body: JSON.stringify({ content: requestContent, language }),
					headers: { "Content-Type": "application/json" },
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new Error(
						errorText || "Error occurred while submitting the translation request",
					);
				}

				const batchResult = await handleStream(response);
				if (batchResult.translatedSegmentCount !== requestGroup.length) {
					throw new Error(
						`Incomplete translation batch. Expected ${requestGroup.length}, received ${batchResult.translatedSegmentCount}.`,
					);
				}

				translatedSegmentCount += batchResult.translatedSegmentCount;
				translatedContent += `${batchResult.content.trimEnd()}\n\n`;
			}

			if (translatedSegmentCount !== originalSegments.length) {
				throw new Error(
					`Incomplete translation. Expected ${originalSegments.length}, received ${translatedSegmentCount}.`,
				);
			}

			// Define all known suffixes
			const knownSuffixes = [".eng", ".spa", ".pop"];

			// First, remove any existing known suffix from the filename
			let baseName = filename.replace(/\.srt$/i, "");

			// Check if the filename already ends with one of the known suffixes
			for (const suffix of knownSuffixes) {
				if (baseName.toLowerCase().endsWith(suffix.toLowerCase())) {
					// Remove the suffix from the base name
					baseName = baseName.slice(0, -suffix.length);
					break;
				}
			}

			// Determine the language suffix based on the selected language
			let languageSuffix = "";
			if (language === "Spanish (Spain)") {
				languageSuffix = ".spa";
			} else if (language === "English") {
				languageSuffix = ".eng";
			} else if (language === "Portuguese (Portugal)") {
				languageSuffix = ".pop";
			}
			// For custom languages, no suffix is added

			// Create the new filename with the appropriate suffix
			const outputFilename = `${baseName}${languageSuffix}.srt`;

			if (translatedContent.trim()) {
				setStatus("done");
				triggerFileDownload(outputFilename, translatedContent);
			} else {
				setStatus("idle");
				alert("Error occurred while reading the translated output.");
			}
		} catch (error) {
			setStatus("idle");
			alert(
				"Translation did not complete. Please retry with the latest app version.",
			);
			console.error(
				"Error during file reading and translation request:",
				error,
			);
		}
	}

	return (
		<main
			className={classNames(
				"max-w-2xl flex flex-col items-center mx-auto",
				libre.className,
			)}
		>
			{configOk === false && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						Configuration error
					</h1>
					<p className="px-4 text-center">
						{configMessage}
					</p>
				</>
			)}
			{configOk !== false && status === "idle" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						Translate any SRT, to any language
					</h1>
					<Form onSubmit={handleSubmit} />
				</>
			)}
			{configOk !== false && status === "busy" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						Translating&hellip;
					</h1>
					<p>(The file will automatically download when it&apos;s done)</p>
					<Translating
						chunks={translatedChunks.map((chunk, i) => ({
							...chunk,
							originalText: originalChunks[i]?.text,
						}))}
					/>
				</>
			)}
			{configOk !== false && status === "done" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						All done!
					</h1>
					<p>Check your &quot;Downloads&quot; folder 🍿</p>
					<p>
						<br />{" "}
						<Link href="/">
							Translate another file 🔄
						</Link>
					</p>
					<p className="mt-10 text-[#444444]">
						Psst. Need to edit your SRT? Try{" "}
						<a
							href="https://www.veed.io/subtitle-tools/edit?locale=en&source=/tools/subtitle-editor/srt-editor"
							target="_blank"
							rel="noreferrer"
						>
							this tool
						</a>
					</p>
					
				</>
			)}
		</main>
	);
}
