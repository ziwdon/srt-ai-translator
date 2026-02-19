"use client";

import React, { FormEvent, useMemo, useState } from "react";
import Image from "next/image";

interface Props {
	onSubmit: (
		content: string,
		language: string,
		filename: string,
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
	const [file, setFile] = useState<File>();
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

	const canSubmit = Boolean(file && language && !isSubmitting);

	const setSelectedFile = (incomingFile?: File) => {
		if (!incomingFile) return;
		if (!isSrtFile(incomingFile)) {
			setFile(undefined);
			setFileError("Please upload a valid .srt subtitle file.");
			return;
		}

		setFileError(null);
		setFile(incomingFile);
	};

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		if (!file || !language || isSubmitting) {
			return;
		}

		try {
			setIsSubmitting(true);
			const content = await readFileContents(file);
			onSubmit(content, language, file.name);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setDragging(false);

		if (!event.dataTransfer.files?.length) return;
		setSelectedFile(event.dataTransfer.files[0]);
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
									onChange={(event) => setSelectedFile(event.target.files?.[0])}
									className="absolute inset-0 cursor-pointer opacity-0"
								/>
								<div className="space-y-1">
									<p className="text-sm font-semibold text-slate-800">
										{file
											? "File selected and ready for translation"
											: "Drag and drop your subtitle file here"}
									</p>
									<p className="text-sm text-slate-500">
										{file
											? `${file.name} • ${formatFileSize(file.size)}`
											: "Only .srt files are accepted."}
									</p>
								</div>
								<div className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-indigo-600 shadow-sm">
									{file ? "Replace file" : "Browse file"}
								</div>
							</div>
							{fileError && (
								<p className="mt-2 text-sm font-medium text-rose-600">{fileError}</p>
							)}
						</section>

						<section className={classNames("transition", file ? "opacity-100" : "opacity-65")}>
							<div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-600">
								<span
									className={classNames(
										"inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
										file ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-500",
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
