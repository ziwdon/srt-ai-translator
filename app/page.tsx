"use client";

import React from "react";
import { libre, roaldDahl } from "@/fonts";

import Form from "@/components/Form";
import Timestamp from "@/components/Timestamp";

import type { Chunk, Segment } from "@/types";
import { parseSegment, parseTimestamp } from "@/lib/client";
import { groupSegmentsByTokenLength } from "@/lib/srt";

function classNames(...classes: string[]) {
	return classes.filter(Boolean).join(" ");
}

const DEFAULT_MAX_TOKENS_PER_TRANSLATION_REQUEST = 350;
const SEGMENT_BLOCK_SPLIT_REGEX = /\r?\n\s*\r?\n/;
const MAX_BATCH_RETRIES = 5;
const BASE_BACKOFF_DELAY_MS = 1000;
const MAX_BACKOFF_DELAY_MS = 12000;
const INTER_BATCH_DELAY_MS = 150;
const RETRIABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
type TranslationStatus = "idle" | "busy" | "done";

type TranslationProgress = {
	totalSegments: number;
	translatedSegments: number;
	totalRequests: number;
	completedRequests: number;
	activeRequest: number;
};

const EMPTY_PROGRESS: TranslationProgress = {
	totalSegments: 0,
	translatedSegments: 0,
	totalRequests: 0,
	completedRequests: 0,
	activeRequest: 0,
};

function serializeSegment(segment: Segment): string {
	return `${segment.id}\n${segment.timestamp}\n${segment.text}`;
}

function splitSrtBlocks(content: string): string[] {
	return content
		.replace(/\uFEFF/g, "")
		.split(SEGMENT_BLOCK_SPLIT_REGEX)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function normalizeSegmentIds(segments: Segment[]): Segment[] {
	return segments.map((segment, index) => ({
		...segment,
		id: Number.isFinite(segment.id) && segment.id > 0 ? segment.id : index + 1,
	}));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
	return RETRIABLE_STATUS_CODES.has(status);
}

function getRetryDelayMs(attempt: number): number {
	const exponentialDelay = BASE_BACKOFF_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.floor(Math.random() * 250);
	return Math.min(MAX_BACKOFF_DELAY_MS, exponentialDelay + jitter);
}

async function requestTranslationBatch(
	content: string,
	language: string,
	runId: string,
	requestNumber: number,
	totalRequests: number,
): Promise<Response> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt += 1) {
		let response: Response;
		try {
			response = await fetch("/api", {
				method: "POST",
				body: JSON.stringify({ content, language }),
				headers: {
					"Content-Type": "application/json",
					"x-translation-run-id": runId,
					"x-translation-request-number": String(requestNumber),
					"x-translation-total-requests": String(totalRequests),
				},
			});
		} catch (error) {
			lastError =
				error instanceof Error
					? error
					: new Error("Network error during translation batch request.");

			if (attempt === MAX_BATCH_RETRIES) {
				throw lastError;
			}

			const retryDelayMs = getRetryDelayMs(attempt);
			console.warn(
				`Request batch ${requestNumber} network error. Retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${MAX_BATCH_RETRIES}).`,
			);
			await sleep(retryDelayMs);
			continue;
		}

		if (response.ok) {
			return response;
		}

		const errorText = await response.text().catch(() => "");
		const errorMessage =
			errorText ||
			`Translation request batch ${requestNumber} failed with status ${response.status}.`;
		lastError = new Error(errorMessage);

		if (!isRetriableStatus(response.status) || attempt === MAX_BATCH_RETRIES) {
			throw lastError;
		}

		const retryDelayMs = getRetryDelayMs(attempt);
		console.warn(
			`Request batch ${requestNumber} failed with status ${response.status}. Retrying in ${retryDelayMs}ms (attempt ${attempt + 1}/${MAX_BATCH_RETRIES}).`,
		);
		await sleep(retryDelayMs);
	}

	throw lastError || new Error("Translation batch failed after retries.");
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

function toPercent(value: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(100, Math.round((value / total) * 100));
}

function formatElapsedTime(elapsedSeconds: number): string {
	const minutes = Math.floor(elapsedSeconds / 60)
		.toString()
		.padStart(2, "0");
	const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");
	return `${minutes}:${seconds}`;
}

function ProgressRow({
	label,
	value,
	total,
	percentage,
}: {
	label: string;
	value: number;
	total: number;
	percentage: number;
}) {
	return (
		<div className="space-y-2">
			<div className="flex items-baseline justify-between">
				<p className="text-sm font-medium text-slate-700">{label}</p>
				<p className="text-xs font-semibold text-slate-500">{`${value}/${total}`}</p>
			</div>
			<div className="h-2 rounded-full bg-slate-200">
				<div
					className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-indigo-500 transition-all duration-300"
					style={{ width: `${percentage}%` }}
				/>
			</div>
		</div>
	);
}

function Translating({ chunks }: { chunks: Chunk[] }) {
	if (!chunks.length) {
		return (
			<div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
				Waiting for translated subtitle segments...
			</div>
		);
	}

	return (
		<div className="mt-6 max-h-[30rem] space-y-3 overflow-y-auto pr-1">
			{[...chunks].reverse().map((chunk) => (
				<Timestamp key={`${chunk.index}-${chunk.start}`} {...chunk} />
			))}
		</div>
	);
}

export default function Home() {
	const [status, setStatus] = React.useState<TranslationStatus>("idle");
	const [translatedChunks, setTranslatedChunks] = React.useState<Chunk[]>([]);
	const [originalChunks, setOriginalChunks] = React.useState<Chunk[]>([]);
	const [configOk, setConfigOk] = React.useState<boolean | null>(null);
	const [configMessage, setConfigMessage] = React.useState<string | null>(null);
	const [maxTokensPerTranslationRequest, setMaxTokensPerTranslationRequest] =
		React.useState<number>(DEFAULT_MAX_TOKENS_PER_TRANSLATION_REQUEST);
	const [progress, setProgress] =
		React.useState<TranslationProgress>(EMPTY_PROGRESS);
	const [activeFilename, setActiveFilename] = React.useState<string>("");
	const [activeLanguage, setActiveLanguage] = React.useState<string>("");
	const [startedAt, setStartedAt] = React.useState<number | null>(null);
	const [elapsedSeconds, setElapsedSeconds] = React.useState<number>(0);

	React.useEffect(() => {
		if (status !== "busy" || startedAt === null) {
			return;
		}

		const intervalId = window.setInterval(() => {
			setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
		}, 1000);

		return () => window.clearInterval(intervalId);
	}, [status, startedAt]);

	React.useEffect(() => {
		(async () => {
			try {
				const res = await fetch("/api/config");
				const data = await res.json();
				const configuredTokenLimit =
					typeof data?.maxTokensPerRequest === "number" &&
					Number.isFinite(data.maxTokensPerRequest) &&
					data.maxTokensPerRequest > 0
						? data.maxTokensPerRequest
						: DEFAULT_MAX_TOKENS_PER_TRANSLATION_REQUEST;
				setMaxTokensPerTranslationRequest(configuredTokenLimit);
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

	const resetRunState = React.useCallback(() => {
		setStartedAt(null);
		setElapsedSeconds(0);
		setProgress(EMPTY_PROGRESS);
	}, []);

	const resetToIdle = React.useCallback(() => {
		setStatus("idle");
		setTranslatedChunks([]);
		setOriginalChunks([]);
		setActiveFilename("");
		setActiveLanguage("");
		resetRunState();
	}, [resetRunState]);

	async function handleStream(
		response: Response,
		onTranslatedSegment: () => void,
	): Promise<{
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
				onTranslatedSegment();
				const { id, timestamp, text } = parseSegment(normalizedBlock);
				const safeId = Number.isFinite(id) && id > 0 ? id : translatedSegmentCount;
				const { start, end } = parseTimestamp(timestamp);
				parsedChunks.push({ index: safeId.toString(), start, end, text });
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
			onTranslatedSegment();
			const { id, timestamp, text } = parseSegment(trailingBlock);
			const safeId = Number.isFinite(id) && id > 0 ? id : translatedSegmentCount;
			const { start, end } = parseTimestamp(timestamp);
			setTranslatedChunks((prev) => [
				...prev,
				{ index: safeId.toString(), start, end, text },
			]);
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
			setStartedAt(Date.now());
			setElapsedSeconds(0);
			setActiveFilename(filename);
			setActiveLanguage(language);
			setTranslatedChunks([]);
			setOriginalChunks([]);
			setProgress(EMPTY_PROGRESS);

			const segments = splitSrtBlocks(content);

			if (!segments.length) {
				setStatus("idle");
				resetRunState();
				alert("Invalid SRT file format. Please check your file.");
				return;
			}

			let originalSegments: Segment[] = [];
			try {
				originalSegments = normalizeSegmentIds(segments.map(parseSegment));
				if (!originalSegments.length) {
					throw new Error("No valid subtitle segments found.");
				}
				setOriginalChunks(
					originalSegments.map((seg) => {
						const { start, end } = parseTimestamp(seg.timestamp);
						return {
							index: seg.id.toString(),
							start,
							end,
							text: seg.text,
						};
					}),
				);
			} catch (error) {
				setStatus("idle");
				resetRunState();
				alert("Error parsing SRT file. Please check the file format.");
				console.error("Parsing error:", error);
				return;
			}

			const requestGroups = groupSegmentsByTokenLength(
				originalSegments,
				maxTokensPerTranslationRequest,
			);

			setProgress({
				totalSegments: originalSegments.length,
				translatedSegments: 0,
				totalRequests: requestGroups.length,
				completedRequests: 0,
				activeRequest: requestGroups.length ? 1 : 0,
			});

			let translatedContent = "";
			let translatedSegmentCount = 0;
			const translationRunId = crypto.randomUUID();

			for (let requestIndex = 0; requestIndex < requestGroups.length; requestIndex += 1) {
				const requestGroup = requestGroups[requestIndex];
				setProgress((prev) => ({
					...prev,
					activeRequest: requestIndex + 1,
				}));

				const requestContent = requestGroup.map(serializeSegment).join("\n\n");
				const response = await requestTranslationBatch(
					requestContent,
					language,
					translationRunId,
					requestIndex + 1,
					requestGroups.length,
				);

				const batchResult = await handleStream(response, () => {
					setProgress((prev) => ({
						...prev,
						translatedSegments: Math.min(
							prev.totalSegments,
							prev.translatedSegments + 1,
						),
					}));
				});

				if (batchResult.translatedSegmentCount !== requestGroup.length) {
					throw new Error(
						`Incomplete translation batch. Expected ${requestGroup.length}, received ${batchResult.translatedSegmentCount}.`,
					);
				}

				setProgress((prev) => ({
					...prev,
					completedRequests: Math.min(prev.totalRequests, requestIndex + 1),
				}));
				translatedSegmentCount += batchResult.translatedSegmentCount;
				translatedContent += `${batchResult.content.trimEnd()}\n\n`;
				if (
					INTER_BATCH_DELAY_MS > 0 &&
					requestIndex < requestGroups.length - 1
				) {
					await sleep(INTER_BATCH_DELAY_MS);
				}
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
				setProgress((prev) => ({
					...prev,
					translatedSegments: prev.totalSegments,
					completedRequests: prev.totalRequests,
					activeRequest: prev.totalRequests,
				}));
				setStartedAt(null);
				setStatus("done");
				triggerFileDownload(outputFilename, translatedContent);
			} else {
				setStatus("idle");
				resetRunState();
				alert("Error occurred while reading the translated output.");
			}
		} catch (error) {
			setStatus("idle");
			resetRunState();
			alert(
				"Translation did not complete. Please retry with the latest app version.",
			);
			console.error(
				"Error during file reading and translation request:",
				error,
			);
		}
	}

	const segmentProgress = toPercent(
		progress.translatedSegments,
		progress.totalSegments,
	);
	const requestProgress = toPercent(
		progress.completedRequests,
		progress.totalRequests,
	);
	const titleByStatus: Record<TranslationStatus, string> = {
		idle: "Translate any SRT to any language",
		busy: "Translating subtitles in real time",
		done: "Translation complete",
	};
	const subtitleByStatus: Record<TranslationStatus, string> = {
		idle: "Drop a subtitle file, pick a language, and get a polished translation with automatic download.",
		busy: "You can track both segment-level and request-level progress while translated lines stream in.",
		done: "Your file has been downloaded. Start a new translation whenever you are ready.",
	};

	if (configOk === false) {
		return (
			<main
				className={classNames(
					"relative min-h-screen overflow-hidden px-4 py-8 md:px-8 md:py-12",
					libre.className,
				)}
			>
				<div className="mx-auto w-full max-w-4xl rounded-3xl border border-rose-200 bg-rose-50/90 p-8 shadow-lg">
					<p className="text-xs font-semibold uppercase tracking-wide text-rose-600">
						Configuration required
					</p>
					<h1
						className={classNames(
							"mt-2 text-3xl font-bold text-rose-900 md:text-4xl",
							roaldDahl.className,
						)}
					>
						Configuration error
					</h1>
					<p className="mt-4 text-sm text-rose-900">{configMessage}</p>
				</div>
			</main>
		);
	}

	return (
		<main
			className={classNames(
				"relative min-h-screen overflow-x-hidden px-4 py-8 md:px-8 md:py-12",
				libre.className,
			)}
		>
			<div className="pointer-events-none absolute inset-0 -z-10">
				<div className="absolute left-1/2 top-10 h-72 w-72 -translate-x-1/2 rounded-full bg-indigo-200/45 blur-3xl" />
				<div className="absolute -left-24 top-48 h-80 w-80 rounded-full bg-cyan-200/35 blur-3xl" />
				<div className="absolute -right-24 top-56 h-96 w-96 rounded-full bg-violet-200/30 blur-3xl" />
			</div>

			<div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
				<section className="rounded-3xl border border-slate-200 bg-white/75 px-6 py-7 shadow-xl backdrop-blur md:px-10 md:py-9">
					<div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
						<div className="space-y-3">
							<p className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-700">
								SRT AI Translator
							</p>
							<h1
								className={classNames(
									"text-3xl font-bold text-slate-900 md:text-5xl",
									roaldDahl.className,
								)}
							>
								{titleByStatus[status]}
							</h1>
							<p className="max-w-3xl text-sm text-slate-600 md:text-base">
								{subtitleByStatus[status]}
							</p>
						</div>
						{status === "busy" && (
							<p className="inline-flex items-center rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
								Auto-download will start when complete
							</p>
						)}
					</div>
				</section>

				{configOk === null && (
					<section className="rounded-3xl border border-slate-200 bg-white/80 px-6 py-5 text-sm text-slate-600 shadow-lg">
						Checking configuration...
					</section>
				)}

				{configOk === true && status === "idle" && <Form onSubmit={handleSubmit} />}

				{configOk === true && status === "busy" && (
					<>
						<section className="rounded-3xl border border-slate-200 bg-white/85 p-6 shadow-xl backdrop-blur md:p-8">
							<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
								<div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
									<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
										Translated segments
									</p>
									<p className="mt-2 text-2xl font-bold text-slate-900">
										{progress.translatedSegments}
									</p>
								</div>
								<div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
									<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
										Total segments
									</p>
									<p className="mt-2 text-2xl font-bold text-slate-900">
										{progress.totalSegments}
									</p>
								</div>
								<div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
									<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
										Request batches
									</p>
									<p className="mt-2 text-2xl font-bold text-slate-900">
										{progress.completedRequests}/{progress.totalRequests}
									</p>
								</div>
								<div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
									<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
										Elapsed
									</p>
									<p className="mt-2 text-2xl font-bold text-slate-900">
										{formatElapsedTime(elapsedSeconds)}
									</p>
								</div>
							</div>

							<div className="mt-6 space-y-4">
								<ProgressRow
									label="Segment progress"
									value={progress.translatedSegments}
									total={progress.totalSegments}
									percentage={segmentProgress}
								/>
								<ProgressRow
									label="Request progress"
									value={progress.completedRequests}
									total={progress.totalRequests}
									percentage={requestProgress}
								/>
							</div>

							<p className="mt-4 text-sm text-slate-500">
								Currently processing request{" "}
								<span className="font-semibold text-slate-700">
									{progress.activeRequest || 0}
								</span>{" "}
								of{" "}
								<span className="font-semibold text-slate-700">
									{progress.totalRequests}
								</span>
								.
							</p>
						</section>

						<section className="rounded-3xl border border-slate-200 bg-white/85 p-6 shadow-xl backdrop-blur md:p-8">
							<div className="flex flex-col gap-2">
								<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
									Live preview
								</p>
								<h2 className="text-xl font-semibold text-slate-900">
									Incoming translated subtitle lines
								</h2>
								<p className="text-sm text-slate-600">
									New chunks appear continuously while translation is running.
								</p>
							</div>
							<Translating
								chunks={translatedChunks.map((chunk, index) => ({
									...chunk,
									originalText: originalChunks[index]?.text,
								}))}
							/>
						</section>
					</>
				)}

				{configOk === true && status === "done" && (
					<section className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl md:p-8">
						<div className="grid gap-5 md:grid-cols-[1.3fr_0.7fr] md:items-center">
							<div>
								<p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
									Translation complete
								</p>
								<h2 className="mt-2 text-2xl font-bold text-slate-900 md:text-3xl">
									Your translated subtitle file has been downloaded.
								</h2>
								<p className="mt-3 text-sm text-slate-600">
									Use the action buttons to run another translation or edit your
									SRT file before continuing.
								</p>
								<div className="mt-4 flex flex-wrap gap-2">
									{activeFilename && (
										<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
											File: {activeFilename}
										</span>
									)}
									{activeLanguage && (
										<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
											Language: {activeLanguage}
										</span>
									)}
									<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
										Duration: {formatElapsedTime(elapsedSeconds)}
									</span>
								</div>
							</div>

							<div className="flex flex-col gap-3">
								<button
									type="button"
									onClick={resetToIdle}
									className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
								>
									Translate another file
								</button>
								<a
									href="https://www.veed.io/subtitle-tools/edit?locale=en&source=/tools/subtitle-editor/srt-editor"
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
								>
									Open SRT editor
								</a>
							</div>
						</div>
					</section>
				)}
			</div>
		</main>
	);
}
