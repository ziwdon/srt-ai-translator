type ZipSuccessEntry = {
	outputFilename: string;
	translatedContent: string;
};

function normalizeLanguageForFilename(language: string): string {
	return language
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "custom-language";
}

function formatArchiveTimestamp(date: Date): string {
	const year = date.getFullYear().toString();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${year}${month}${day}-${hours}${minutes}`;
}

function splitFilename(filename: string): { name: string; extension: string } {
	const extensionIndex = filename.lastIndexOf(".");
	if (extensionIndex <= 0) {
		return { name: filename, extension: "" };
	}

	return {
		name: filename.slice(0, extensionIndex),
		extension: filename.slice(extensionIndex),
	};
}

export async function buildZipArchive(
	successes: ZipSuccessEntry[],
	language: string,
): Promise<{ blob: Blob; filename: string }> {
	const { default: JSZip } = await import("jszip");
	const zip = new JSZip();
	const fileNameCount = new Map<string, number>();

	for (const success of successes) {
		const targetOutputFilename = success.outputFilename;
		const seenCount = fileNameCount.get(targetOutputFilename) ?? 0;
		fileNameCount.set(targetOutputFilename, seenCount + 1);

		let uniqueFilename = targetOutputFilename;
		if (seenCount > 0) {
			const { name, extension } = splitFilename(targetOutputFilename);
			uniqueFilename = `${name} (${seenCount})${extension}`;
		}

		zip.file(uniqueFilename, success.translatedContent);
	}

	const blob = await zip.generateAsync({ type: "blob" });
	const archiveFilename = `srt-translations-${normalizeLanguageForFilename(language)}-${formatArchiveTimestamp(new Date())}.zip`;

	return { blob, filename: archiveFilename };
}
