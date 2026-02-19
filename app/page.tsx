"use client";

import React from "react";
import Link from "next/link";
import { libre, roaldDahl } from "@/fonts";

import Form from "@/components/Form";
import Timestamp from "@/components/Timestamp";

import type { Chunk } from "@/types";
import { parseSegment, parseTimestamp } from "@/lib/client";

function classNames(...classes: string[]) {
	return classes.filter(Boolean).join(" ");
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

	async function handleStream(response: Response) {
		const data = response.body;
		if (!data) return;

		let content = "";
		let doneReading = false;
		const reader = data.getReader();
		const decoder = new TextDecoder();

		while (!doneReading) {
			const { value, done } = await reader.read();
			doneReading = done;
			const chunk = decoder.decode(value);

			content += `${chunk}\n\n`;
			if (chunk.trim().length)
				setTranslatedChunks((prev) => [...prev, parseChunk(chunk)]);
		}

		return content;

		function parseChunk(chunkStr: string): Chunk {
			const { id, timestamp, text } = parseSegment(chunkStr);
			const { start, end } = parseTimestamp(timestamp);
			return { index: id.toString(), start, end, text };
		}
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

			try {
				const originalSegments = segments.map(parseSegment);
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

			const response = await fetch("/api", {
				method: "POST",
				body: JSON.stringify({ content, language }),
				headers: { "Content-Type": "application/json" },
			});

			if (response.ok) {
				const translatedContent = await handleStream(response);
				
				// Define all known suffixes
				const knownSuffixes = ['.eng', '.spa', '.pop'];
				
				// First, remove any existing known suffix from the filename
				let baseName = filename.replace(/\.srt$/i, '');
				
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
				
				if (translatedContent) {
					setStatus("done");
					triggerFileDownload(outputFilename, translatedContent);
				} else {
					setStatus("idle");
					alert("Error occurred while reading the file");
				}
			} else {
				setStatus("idle");
				console.error(
					"Error occurred while submitting the translation request",
				);
			}
		} catch (error) {
			setStatus("idle");
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
