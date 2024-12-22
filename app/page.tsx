"use client";

import React from "react";
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
	element.href = URL.createObjectURL(file);
	element.download = filename;
	document.body.appendChild(element);
	element.click();
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
	const [translatedSrt, setTranslatedSrt] = React.useState("");
	const [translatedChunks, setTranslatedChunks] = React.useState<Chunk[]>([]);
	const [originalChunks, setOriginalChunks] = React.useState<Chunk[]>([]);

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
			setTranslatedSrt((prev) => prev + chunk);
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

	async function handleSubmit(content: string, language: string) {
		try {
			if (!content) {
				console.error("No content provided");
				return;
			}

			setStatus("busy");
			// Reset previous state
			setTranslatedSrt("");
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
				const content = await handleStream(response);
				const filename = `${language}.srt`;
				if (content) {
					setStatus("done");
					triggerFileDownload(filename, content);
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
			{status === "idle" && (
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
			{status === "busy" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						Translating&hellip;
					</h1>
					<p>(The file will automatically download when it's done)</p>
					<Translating
						chunks={translatedChunks.map((chunk, i) => ({
							...chunk,
							originalText: originalChunks[i]?.text,
						}))}
					/>
				</>
			)}
			{status === "done" && (
				<>
					<h1
						className={classNames(
							"px-4 text-3xl md:text-5xl text-center font-bold my-6",
							roaldDahl.className,
						)}
					>
						All done!
					</h1>
					<p>Check your "Downloads" folder 🍿</p>
					<p className="mt-4 text-[#444444]">
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
