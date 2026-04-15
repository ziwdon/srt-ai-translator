"use client";

import React, { FormEvent, useMemo, useState } from "react";
import Image from "next/image";

interface Props {
	onSubmit: (
		queue: { filename: string; content: string }[],
		language: string,
	) => void | Promise<void>;
}

function classNames(...classes: string[]) {
	return classes.filter(Boolean).join(" ");
}

const PREDEFINED_LANGUAGES = [
	"English",
	"Portuguese (Portugal)",
	"Spanish (Spain)",
];
const CUSTOM_LANGUAGE_OPTION = "custom";

const readFileContents = async (file: File): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onload = (event) => {
			resolve((event.target?.result as string) ?? "");
		};

		reader.onerror = (event) => {
			reject(event);
		};

		reader.readAsText(file);
	});

const isSrtFile = (incomingFile: File) =>
	incomingFile.name.toLowerCase().endsWith(".srt");

const formatFileSize = (sizeInBytes: number) => {
	if (sizeInBytes < 1024) return `${sizeInBytes} B`;
	if (sizeInBytes < 1024 * 1024) return `${(sizeInBytes / 1024).toFixed(1)} KB`;
	return `${(sizeInBytes / (1024 * 1024)).toFixed(1)} MB`;
};

const SrtForm: React.FC<Props> = ({ onSubmit }) => {
	const [files, setFiles] = useState<File[]>([]);
	const [selectedOption, setSelectedOption] = useState<string>("");
	const [customLanguage, setCustomLanguage] = useState<string>("");
	const [dragging, setDragging] = useState<boolean>(false);
	const [fileError, setFileError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

	const language = useMemo(
		() =>
			selectedOption === CUSTOM_LANGUAGE_OPTION
				? customLanguage.trim()
				: selectedOption,
		[selectedOption, customLanguage],
	);

	const canSubmit = Boolean(files.length && language && !isSubmitting);

	const appendFiles = (incomingFiles: File[]) => {
		if (!incomingFiles.length) {
			return;
		}

		const invalidFiles: string[] = [];
		const validFiles: File[] = [];
		for (const incomingFile of incomingFiles) {
			if (!isSrtFile(incomingFile)) {
				invalidFiles.push(incomingFile.name);
				continue;
			}
			validFiles.push(incomingFile);
		}

		setFiles((prev) => {
			const seen = new Set(prev.map((existingFile) => `${existingFile.name}:${existingFile.size}`));
			const next = [...prev];

			for (const incomingFile of validFiles) {
				const key = `${incomingFile.name}:${incomingFile.size}`;
				if (seen.has(key)) {
					continue;
				}

				seen.add(key);
				next.push(incomingFile);
			}

			return next;
		});

		if (invalidFiles.length) {
			setFileError(
				invalidFiles.length === 1
					? `Ignored "${invalidFiles[0]}". Please upload valid .srt files only.`
					: `Ignored ${invalidFiles.length} invalid files. Please upload valid .srt files only.`,
			);
			return;
		}

		setFileError(null);
	};

	const removeFile = (targetFileIndex: number) => {
		setFiles((prev) => prev.filter((_, index) => index !== targetFileIndex));
	};

	const clearAllFiles = () => {
		setFiles([]);
		setFileError(null);
	};

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		if (!files.length || !language || isSubmitting) {
			return;
		}

		try {
			setIsSubmitting(true);
			const queue = await Promise.all(
				files.map(async (file) => ({
					filename: file.name,
					content: await readFileContents(file),
				})),
			);
			await onSubmit(queue, language);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setDragging(false);

		if (!event.dataTransfer.files?.length) return;
		appendFiles(Array.from(event.dataTransfer.files));
	};

	return (
		<form onSubmit={handleSubmit} className="w-full">
			<div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-xl backdrop-blur md:p-8">
				<div className="pointer-events-none absolute -left-14 top-8 h-36 w-36 rounded-full bg-indigo-200/40 blur-3xl" />
				<div className="pointer-events-none absolute -right-14 -top-10 h-48 w-48 rounded-full bg-cyan-200/40 blur-3xl" />

				<div className="relative grid gap-8 lg:grid-cols-[1.35fr_0.95fr]">
					<div className="space-y-6">
						<section>
							<div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600">
								<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs text-white">
									1
								</span>
								<span>Upload your SRT file</span>
							</div>
							<div
								onDragOver={(event) => {
									event.preventDefault();
									setDragging(true);
								}}
								onDragLeave={() => setDragging(false)}
								onDrop={handleDrop}
								className={classNames(
									"relative flex min-h-32 items-center justify-between gap-4 rounded-2xl border-2 border-dashed bg-slate-50/85 px-5 py-5 transition",
									dragging
										? "border-indigo-400 shadow-lg shadow-indigo-100"
										: "border-slate-300",
								)}
							>
								<input
									type="file"
									accept=".srt"
									multiple
									onChange={(event) => {
										appendFiles(Array.from(event.target.files ?? []));
										event.currentTarget.value = "";
									}}
									className="absolute inset-0 cursor-pointer opacity-0"
								/>
								<div className="space-y-1">
									<p className="text-sm font-semibold text-slate-800">
										{files.length
											? `${files.length} file${files.length > 1 ? "s" : ""} ready - drop more to add`
											: "Drag and drop subtitle files here"}
									</p>
									<p className="text-sm text-slate-500">
										{files.length
											? "Queued files are translated one by one."
											: "Only .srt files are accepted."}
									</p>
								</div>
								<div className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-indigo-600 shadow-sm">
									{files.length ? "Add files" : "Browse files"}
								</div>
							</div>
							{fileError && (
								<p className="mt-2 text-sm font-medium text-rose-600">{fileError}</p>
							)}
							{files.length > 0 && (
								<div className="mt-4 rounded-2xl border border-slate-200 bg-white">
									<div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
										<p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
											Queued files
										</p>
										<button
											type="button"
											onClick={clearAllFiles}
											className="text-xs font-semibold text-slate-500 transition hover:text-slate-700"
										>
											Clear all
										</button>
									</div>
									<ul className="max-h-44 divide-y divide-slate-100 overflow-y-auto">
										{files.map((queuedFile, index) => (
											<li
												key={`${queuedFile.name}:${queuedFile.size}:${index}`}
												className="flex items-center justify-between gap-3 px-4 py-2.5"
											>
												<div className="min-w-0">
													<p className="truncate text-sm font-medium text-slate-800">
														{queuedFile.name}
													</p>
													<p className="text-xs text-slate-500">
														{formatFileSize(queuedFile.size)}
													</p>
												</div>
												<button
													type="button"
													onClick={() => removeFile(index)}
													className="rounded-md px-2 py-1 text-sm font-semibold text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
													aria-label={`Remove ${queuedFile.name}`}
												>
													&times;
												</button>
											</li>
										))}
									</ul>
								</div>
							)}
						</section>

						<section
							className={classNames(
								"transition",
								files.length ? "opacity-100" : "opacity-65",
							)}
						>
							<div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600">
								<span
									className={classNames(
										"inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
										files.length
											? "bg-slate-900 text-white"
											: "bg-slate-200 text-slate-500",
									)}
								>
									2
								</span>
								<span>Choose translation language</span>
							</div>
							<div className="rounded-2xl border border-slate-200 bg-white p-4">
								<div className="flex flex-col gap-3 sm:flex-row">
									<select
										id="language"
										value={selectedOption}
										onChange={(event) => setSelectedOption(event.target.value)}
										className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-700 outline-none ring-indigo-200 transition focus:ring-2"
									>
										<option value="">Choose language...</option>
										{PREDEFINED_LANGUAGES.map((item) => (
											<option key={item} value={item}>
												{item}
											</option>
										))}
										<option value={CUSTOM_LANGUAGE_OPTION}>Custom language...</option>
									</select>

									{selectedOption === CUSTOM_LANGUAGE_OPTION && (
										<input
											type="text"
											id="customLanguage"
											value={customLanguage}
											onChange={(event) => setCustomLanguage(event.target.value)}
											placeholder="Enter custom language..."
											className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-700 outline-none ring-indigo-200 transition focus:ring-2"
											autoFocus
										/>
									)}
								</div>
							</div>
						</section>

						<button
							type="submit"
							disabled={!canSubmit}
							className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
						>
							{isSubmitting
								? "Preparing translation..."
								: files.length > 1
									? `Translate ${files.length} files${language ? ` to ${language}` : ""}`
									: `Translate${language ? ` to ${language}` : ""}`}
						</button>
					</div>

					<aside className="rounded-2xl border border-slate-200 bg-slate-50/80 p-5">
						<Image
							src="/hero-translation.svg"
							alt="Subtitle translation workflow illustration"
							width={520}
							height={340}
							className="h-auto w-full"
							priority
						/>
						<h3 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
							Faster subtitle workflow
						</h3>
						<div className="mt-3 space-y-2 text-sm text-slate-600">
							<p>Live progress while chunks stream back from the model.</p>
							<p>Automatic download when translation is complete.</p>
							<p>Supports predefined and custom target languages.</p>
						</div>
					</aside>
				</div>
			</div>
		</form>
	);
};

export default SrtForm;
