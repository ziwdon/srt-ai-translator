"use client";

import React from "react";
import { libre, roaldDahl } from "@/fonts";

import Form from "@/components/Form";
import OffsetForm from "@/components/OffsetForm";
import Timestamp from "@/components/Timestamp";

import type { Chunk, Segment } from "@/types";
import { parseSegment, parseTimestamp, applyOffsetToTimestampLine } from "@/lib/client";
import { groupSegmentsByTokenLength } from "@/lib/srt";
import { buildZipArchive } from "@/lib/zip";

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
type AppMode = "translate" | "offset";

type TranslationProgress = {
	totalSegments: number;
	translatedSegments: number;
	totalRequests: number;
	completedRequests: number;
	activeRequest: number;
};

type FileResultStatus = "pending" | "translating" | "success" | "failed";
type FileResult = {
	filename: string;
	content: string;
	status: FileResultStatus;
	translatedContent?: string;
	outputFilename?: string;
	error?: string;
};

type BulkProgress = {
	totalFiles: number;
	completedFiles: number;
	activeFileIndex: number;
};

type QueueItem = {
	filename: string;
	content: string;
	resultIndex?: number;
};

const EMPTY_PROGRESS: TranslationProgress = {
	totalSegments: 0,
	translatedSegments: 0,
	totalRequests: 0,
	completedRequests: 0,
	activeRequest: 0,
};

const EMPTY_BULK_PROGRESS: BulkProgress = {
	totalFiles: 0,
	completedFiles: 0,
	activeFileIndex: -1,
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

const triggerFileDownload = (filename: string, content: string | Blob) => {
	const element = document.createElement("a");
	const file =
		typeof content === "string"
			? new Blob([content], { type: "text/plain" })
			: content;
	const fileUrl = URL.createObjectURL(file);
	element.href = fileUrl;
	element.download = filename;
	document.body.appendChild(element);
	element.click();
	element.remove();
	URL.revokeObjectURL(fileUrl);
};

const triggerFileDownloadFromUrl = (filename: string, fileUrl: string) => {
	const element = document.createElement("a");
	element.href = fileUrl;
	element.download = filename;
	document.body.appendChild(element);
	element.click();
	element.remove();
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

function getFileStatusLabel(status: FileResultStatus): string {
	switch (status) {
		case "pending":
			return "Pending";
		case "translating":
			return "Translating";
		case "success":
			return "Success";
		case "failed":
			return "Failed";
		default:
			return status;
	}
}

function getFileStatusClasses(status: FileResultStatus): string {
	switch (status) {
		case "pending":
			return "border-slate-200 bg-slate-100 text-slate-600";
		case "translating":
			return "animate-pulse border-indigo-200 bg-indigo-50 text-indigo-700";
		case "success":
			return "border-emerald-200 bg-emerald-50 text-emerald-700";
		case "failed":
			return "border-rose-200 bg-rose-50 text-rose-700";
		default:
			return "border-slate-200 bg-slate-100 text-slate-600";
	}
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
	const [activeMode, setActiveMode] = React.useState<AppMode>("translate");
	const [activeOffsetMs, setActiveOffsetMs] = React.useState<number>(0);
	const [fileResults, setFileResults] = React.useState<FileResult[]>([]);
	const [bulkProgress, setBulkProgress] =
		React.useState<BulkProgress>(EMPTY_BULK_PROGRESS);
	const [zipDownload, setZipDownload] = React.useState<{
		filename: string;
		url: string;
	} | null>(null);

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

	const clearZipDownload = React.useCallback(() => {
		setZipDownload((prev) => {
			if (prev) {
				URL.revokeObjectURL(prev.url);
			}
			return null;
		});
	}, []);

	const resetRunState = React.useCallback(() => {
		setStartedAt(null);
		setElapsedSeconds(0);
		setProgress(EMPTY_PROGRESS);
		setBulkProgress(EMPTY_BULK_PROGRESS);
		clearZipDownload();
	}, [clearZipDownload]);

	const resetToIdle = React.useCallback(() => {
		setStatus("idle");
		setTranslatedChunks([]);
		setOriginalChunks([]);
		setActiveFilename("");
		setActiveLanguage("");
		setActiveOffsetMs(0);
		setFileResults([]);
		setBulkProgress(EMPTY_BULK_PROGRESS);
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

	async function translateSingleFile(
		content: string,
		language: string,
		filename: string,
	): Promise<{ translatedContent: string; outputFilename: string }> {
		if (!content) {
			throw new Error("No content provided.");
		}

		setActiveFilename(filename);
		setActiveLanguage(language);
		setTranslatedChunks([]);
		setOriginalChunks([]);
		setProgress(EMPTY_PROGRESS);

		const segments = splitSrtBlocks(content);
		if (!segments.length) {
			throw new Error("Invalid SRT file format. Please check your file.");
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
			console.error("Parsing error:", error);
			throw new Error("Error parsing SRT file. Please check the file format.");
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
					translatedSegments: Math.min(prev.totalSegments, prev.translatedSegments + 1),
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
			if (INTER_BATCH_DELAY_MS > 0 && requestIndex < requestGroups.length - 1) {
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

		if (!translatedContent.trim()) {
			throw new Error("Error occurred while reading the translated output.");
		}

		setProgress((prev) => ({
			...prev,
			translatedSegments: prev.totalSegments,
			completedRequests: prev.totalRequests,
			activeRequest: prev.totalRequests,
		}));

		return { translatedContent, outputFilename };
	}

	async function finalizeBulkRun(results: FileResult[], language: string) {
		const successes = results.filter(
			(result): result is FileResult &
				Required<Pick<FileResult, "translatedContent" | "outputFilename">> =>
				result.status === "success" &&
				typeof result.translatedContent === "string" &&
				typeof result.outputFilename === "string",
		);

		setFileResults(results);
		setBulkProgress({
			totalFiles: results.length,
			completedFiles: results.length,
			activeFileIndex: -1,
		});

		if (!successes.length) {
			setStatus("idle");
			resetRunState();
			alert("All translations failed. See console for details.");
			return;
		}

		if (results.length === 1 && successes.length === 1) {
			clearZipDownload();
			triggerFileDownload(successes[0].outputFilename, successes[0].translatedContent);
			setStatus("done");
			return;
		}

		// Keep successful contents in memory to enable one-click ZIP redownload.
		const { blob, filename } = await buildZipArchive(
			successes.map((success) => ({
				outputFilename: success.outputFilename,
				translatedContent: success.translatedContent,
			})),
			language,
		);

		triggerFileDownload(filename, blob);
		setZipDownload((prev) => {
			if (prev) {
				URL.revokeObjectURL(prev.url);
			}
			return {
				filename,
				url: URL.createObjectURL(blob),
			};
		});
		setStatus("done");
	}

	async function handleBulkSubmit(queue: QueueItem[], language: string) {
		if (!queue.length) {
			return;
		}

		if (queue.length === 1 && !queue[0].content) {
			console.error("No content provided");
			return;
		}

		const hasIndexedItems = queue.some((item) => Number.isInteger(item.resultIndex));
		const initialResults: FileResult[] =
			hasIndexedItems && fileResults.length
				? fileResults.map((result) => ({ ...result }))
				: queue.map((item) => ({
						filename: item.filename,
						content: item.content,
						status: "pending" as const,
				  }));

		if (hasIndexedItems) {
			for (const item of queue) {
				const targetIndex = item.resultIndex ?? -1;
				if (targetIndex < 0 || targetIndex >= initialResults.length) {
					continue;
				}

				initialResults[targetIndex] = {
					...initialResults[targetIndex],
					filename: item.filename,
					content: item.content,
					status: "pending",
					error: undefined,
				};
			}
		}

		setFileResults(initialResults);
		setStatus("busy");
		setStartedAt(Date.now());
		setElapsedSeconds(0);

		const initialCompletedFiles = initialResults.filter(
			(result) => result.status === "success",
		).length;
		setBulkProgress({
			totalFiles: initialResults.length,
			completedFiles: initialCompletedFiles,
			activeFileIndex: -1,
		});

		try {
			const nextResults = [...initialResults];
			let completedFiles = initialCompletedFiles;

			for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
				const queueItem = queue[queueIndex];
				const targetIndex = queueItem.resultIndex ?? queueIndex;
				if (targetIndex < 0 || targetIndex >= nextResults.length) {
					continue;
				}

				nextResults[targetIndex] = {
					...nextResults[targetIndex],
					status: "translating",
					error: undefined,
				};
				setFileResults([...nextResults]);
				setBulkProgress((prev) => ({
					...prev,
					activeFileIndex: targetIndex,
				}));

				try {
					const { translatedContent, outputFilename } = await translateSingleFile(
						queueItem.content,
						language,
						queueItem.filename,
					);
					nextResults[targetIndex] = {
						...nextResults[targetIndex],
						status: "success",
						translatedContent,
						outputFilename,
						error: undefined,
					};
				} catch (error) {
					console.error(`Translation failed for ${queueItem.filename}`, error);
					nextResults[targetIndex] = {
						...nextResults[targetIndex],
						status: "failed",
						error:
							error instanceof Error
								? error.message
								: "Unknown translation error.",
					};
				}

				completedFiles += 1;
				setFileResults([...nextResults]);
				setBulkProgress((prev) => ({
					...prev,
					completedFiles,
					activeFileIndex: targetIndex,
				}));
			}

			await finalizeBulkRun(nextResults, language);
		} catch (error) {
			setStatus("idle");
			resetRunState();
			alert(
				"Translation did not complete. Please retry with the latest app version.",
			);
			console.error("Error during bulk translation run:", error);
		} finally {
			setStartedAt(null);
		}
	}

	async function handleRetryFailed() {
		if (!activeLanguage) {
			return;
		}

		const retryQueue = fileResults
			.map((result, index) => ({ result, index }))
			.filter(({ result }) => result.status === "failed")
			.map(({ result, index }) => ({
				filename: result.filename,
				content: result.content,
				resultIndex: index,
			}));

		if (!retryQueue.length) {
			return;
		}

		await handleBulkSubmit(retryQueue, activeLanguage);
	}

	function handleOffset(content: string, offsetMs: number, filename: string) {
		if (!content) {
			console.error("No content provided");
			return;
		}

		try {
			const blocks = splitSrtBlocks(content);
			if (!blocks.length) {
				alert("Invalid SRT file format. Please check your file.");
				return;
			}

			const segments = normalizeSegmentIds(blocks.map(parseSegment));
			if (!segments.length) {
				alert("No valid subtitle segments found.");
				return;
			}

			const offsetContent =
				segments
					.map((segment) => {
						const newTimestamp = applyOffsetToTimestampLine(
							segment.timestamp,
							offsetMs,
						);
						return `${segment.id}\n${newTimestamp}\n${segment.text}`;
					})
					.join("\n\n") + "\n";

			setActiveFilename(filename);
			setActiveOffsetMs(offsetMs);
			setStatus("done");
			triggerFileDownload(filename, offsetContent);
		} catch (error) {
			alert("Error processing SRT file. Please check the file format.");
			console.error("Offset processing error:", error);
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
	const fileProgress = toPercent(
		bulkProgress.completedFiles,
		bulkProgress.totalFiles,
	);
	const showBulkProgress = bulkProgress.totalFiles > 1;
	const successCount = fileResults.filter((result) => result.status === "success").length;
	const failureCount = fileResults.filter((result) => result.status === "failed").length;
	const activeFileNumber =
		bulkProgress.activeFileIndex >= 0
			? bulkProgress.activeFileIndex + 1
			: Math.min(bulkProgress.completedFiles, bulkProgress.totalFiles);

	const titles: Record<AppMode, Record<TranslationStatus, string>> = {
		translate: {
			idle: "Translate any SRT to any language",
			busy: "Translating subtitles in real time",
			done: "Translation complete",
		},
		offset: {
			idle: "Adjust subtitle timing with precision",
			busy: "Applying time offset",
			done: "Time offset applied",
		},
	};
	const subtitleTexts: Record<AppMode, Record<TranslationStatus, string>> = {
		translate: {
			idle: "Drop a subtitle file, pick a language, and get a polished translation with automatic download.",
			busy: "You can track both segment-level and request-level progress while translated lines stream in.",
			done: "Your file has been downloaded. Start a new translation whenever you are ready.",
		},
		offset: {
			idle: "Upload an SRT file and apply a positive or negative millisecond offset to every timestamp.",
			busy: "Processing your file...",
			done: "Your file has been downloaded with adjusted timestamps. Process another file whenever you are ready.",
		},
	};
	const headingTitle =
		activeMode === "translate" && status === "done" && showBulkProgress
			? failureCount
				? "Bulk translation finished with failures"
				: "Bulk translation complete"
			: titles[activeMode][status];
	const headingSubtitle =
		activeMode === "translate" && status === "done" && showBulkProgress
			? failureCount
				? "Successful files are packaged in a ZIP. Retry failed files directly from the results panel."
				: "All files were translated and archived into a single ZIP download."
			: subtitleTexts[activeMode][status];

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
								{headingTitle}
							</h1>
							<p className="max-w-3xl text-sm text-slate-600 md:text-base">
								{headingSubtitle}
							</p>
							{status === "idle" && (
								<div className="inline-flex gap-1 rounded-xl bg-slate-100 p-1">
									<button
										type="button"
										onClick={() => setActiveMode("translate")}
										className={classNames(
											"rounded-lg px-4 py-2 text-sm font-semibold transition",
											activeMode === "translate"
												? "bg-white text-slate-900 shadow-sm"
												: "text-slate-500 hover:text-slate-700",
										)}
									>
										Translate
									</button>
									<button
										type="button"
										onClick={() => setActiveMode("offset")}
										className={classNames(
											"rounded-lg px-4 py-2 text-sm font-semibold transition",
											activeMode === "offset"
												? "bg-white text-slate-900 shadow-sm"
												: "text-slate-500 hover:text-slate-700",
										)}
									>
										Time Offset
									</button>
								</div>
							)}
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

				{configOk === true && status === "idle" && activeMode === "translate" && (
					<Form onSubmit={handleBulkSubmit} />
				)}
				{configOk === true && status === "idle" && activeMode === "offset" && (
					<OffsetForm onSubmit={handleOffset} />
				)}

				{configOk === true && status === "busy" && activeMode === "translate" && (
					<>
						<section className="rounded-3xl border border-slate-200 bg-white/85 p-6 shadow-xl backdrop-blur md:p-8">
							<div
								className={classNames(
									"grid gap-3 sm:grid-cols-2",
									showBulkProgress ? "lg:grid-cols-5" : "lg:grid-cols-4",
								)}
							>
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
								{showBulkProgress && (
									<div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
										<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
											Files
										</p>
										<p className="mt-2 text-2xl font-bold text-slate-900">
											{bulkProgress.completedFiles}/{bulkProgress.totalFiles}
										</p>
									</div>
								)}
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
								{showBulkProgress && (
									<ProgressRow
										label="File progress"
										value={bulkProgress.completedFiles}
										total={bulkProgress.totalFiles}
										percentage={fileProgress}
									/>
								)}
							</div>

							<p className="mt-4 text-sm text-slate-500">
								{showBulkProgress ? (
									<>
										File{" "}
										<span className="font-semibold text-slate-700">
											{activeFileNumber || 0}
										</span>{" "}
										of{" "}
										<span className="font-semibold text-slate-700">
											{bulkProgress.totalFiles}
										</span>{" "}
										- request{" "}
										<span className="font-semibold text-slate-700">
											{progress.activeRequest || 0}
										</span>{" "}
										of{" "}
										<span className="font-semibold text-slate-700">
											{progress.totalRequests}
										</span>
										.
									</>
								) : (
									<>
										Currently processing request{" "}
										<span className="font-semibold text-slate-700">
											{progress.activeRequest || 0}
										</span>{" "}
										of{" "}
										<span className="font-semibold text-slate-700">
											{progress.totalRequests}
										</span>
										.
									</>
								)}
							</p>

							{showBulkProgress && (
								<div className="mt-4 rounded-2xl border border-slate-200 bg-white">
									<div className="border-b border-slate-100 px-4 py-3">
										<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
											File queue status
										</p>
									</div>
									<ul className="max-h-52 divide-y divide-slate-100 overflow-y-auto">
										{fileResults.map((result, index) => (
											<li
												key={`${result.filename}:${index}`}
												className="flex items-center justify-between gap-3 px-4 py-2.5"
											>
												<p className="truncate text-sm font-medium text-slate-700">
													{result.filename}
												</p>
												<span
													title={
														result.status === "failed" ? result.error || "" : ""
													}
													className={classNames(
														"shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold",
														getFileStatusClasses(result.status),
													)}
												>
													{getFileStatusLabel(result.status)}
												</span>
											</li>
										))}
									</ul>
								</div>
							)}
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
					<>
						{activeMode === "translate" && showBulkProgress ? (
							<section className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl md:p-8">
								<div className="grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
									<div>
										<p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
											{failureCount
												? `Bulk translation finished with ${failureCount} failure(s)`
												: "Bulk translation complete"}
										</p>
										<h2 className="mt-2 text-2xl font-bold text-slate-900 md:text-3xl">
											{failureCount
												? "Successful files were packaged. Failed files are listed below."
												: "All queued subtitle files were translated and downloaded as a ZIP."}
										</h2>
										<p className="mt-3 text-sm text-slate-600">
											Review file outcomes, download the archive again, or retry only failed files.
										</p>

										<div className="mt-4 flex flex-wrap gap-2">
											<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
												Files: {successCount}/{fileResults.length} succeeded
											</span>
											{activeLanguage && (
												<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
													Language: {activeLanguage}
												</span>
											)}
											<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
												Duration: {formatElapsedTime(elapsedSeconds)}
											</span>
										</div>

										<div className="mt-5 overflow-x-auto rounded-2xl border border-slate-200">
											<table className="min-w-full divide-y divide-slate-200 text-left text-sm">
												<thead className="bg-slate-50">
													<tr>
														<th className="px-4 py-3 font-semibold text-slate-600">
															Filename
														</th>
														<th className="px-4 py-3 font-semibold text-slate-600">
															Status
														</th>
														<th className="px-4 py-3 font-semibold text-slate-600">
															Error
														</th>
													</tr>
												</thead>
												<tbody className="divide-y divide-slate-100 bg-white">
													{fileResults.map((result, index) => (
														<tr key={`${result.filename}:${index}`}>
															<td className="max-w-xs px-4 py-3 font-medium text-slate-700">
																<span className="block truncate">{result.filename}</span>
															</td>
															<td className="px-4 py-3">
																<span
																	className={classNames(
																		"inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
																		getFileStatusClasses(result.status),
																	)}
																>
																	{getFileStatusLabel(result.status)}
																</span>
															</td>
															<td className="px-4 py-3 text-slate-500">
																{result.status === "failed" ? result.error || "-" : "-"}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</div>

									<div className="flex flex-col gap-3">
										{zipDownload && (
											<button
												type="button"
												onClick={() =>
													triggerFileDownloadFromUrl(
														zipDownload.filename,
														zipDownload.url,
													)
												}
												className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
											>
												Download ZIP again
											</button>
										)}
										{failureCount > 0 && (
											<button
												type="button"
												onClick={handleRetryFailed}
												className="inline-flex items-center justify-center rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
											>
												Retry failed ({failureCount})
											</button>
										)}
										<button
											type="button"
											onClick={resetToIdle}
											className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
										>
											Translate another batch
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
						) : (
							<section className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl md:p-8">
								<div className="grid gap-5 md:grid-cols-[1.3fr_0.7fr] md:items-center">
									<div>
										<p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
											{activeMode === "translate"
												? "Translation complete"
												: "Time offset applied"}
										</p>
										<h2 className="mt-2 text-2xl font-bold text-slate-900 md:text-3xl">
											{activeMode === "translate"
												? "Your translated subtitle file has been downloaded."
												: "Your time-adjusted subtitle file has been downloaded."}
										</h2>
										<p className="mt-3 text-sm text-slate-600">
											{activeMode === "translate"
												? "Use the action buttons to run another translation or edit your SRT file before continuing."
												: "Use the action buttons to process another file or edit your SRT file."}
										</p>
										<div className="mt-4 flex flex-wrap gap-2">
											{activeFilename && (
												<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
													File: {activeFilename}
												</span>
											)}
											{activeMode === "translate" && activeLanguage && (
												<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
													Language: {activeLanguage}
												</span>
											)}
											{activeMode === "offset" && activeOffsetMs !== 0 && (
												<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
													Offset: {activeOffsetMs > 0 ? "+" : ""}
													{activeOffsetMs} ms
												</span>
											)}
											{activeMode === "translate" && (
												<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
													Duration: {formatElapsedTime(elapsedSeconds)}
												</span>
											)}
										</div>
									</div>

									<div className="flex flex-col gap-3">
										<button
											type="button"
											onClick={resetToIdle}
											className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
										>
											{activeMode === "translate"
												? "Translate another file"
												: "Process another file"}
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
					</>
				)}
			</div>
		</main>
	);
}
