import { Segment } from "@/types";

const TIMESTAMP_LINE_REGEX =
  /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/;

export function parseSegment(text: string): Segment {
  const rawLines = text.split(/\r\n|\n/);
  const normalizedLines = rawLines.map((line) => line.trim());

  const timestampIndex = normalizedLines.findIndex((line) =>
    TIMESTAMP_LINE_REGEX.test(line),
  );

  let id = Number.NaN;
  if (timestampIndex > 0) {
    const idLine =
      normalizedLines
        .slice(0, timestampIndex)
        .find((line) => line.length > 0) ?? "";
    id = Number.parseInt(idLine, 10);
  }

  const timestamp = timestampIndex >= 0 ? normalizedLines[timestampIndex] : "";
  const textLines = (timestampIndex >= 0
    ? rawLines.slice(timestampIndex + 1)
    : rawLines
  ).map((line) => line.trimEnd());

  const firstContentLine = textLines.findIndex((line) => line.trim().length > 0);
  const lastContentLine =
    textLines.length -
    1 -
    [...textLines].reverse().findIndex((line) => line.trim().length > 0);
  const boundedTextLines =
    firstContentLine >= 0 &&
    lastContentLine >= firstContentLine &&
    Number.isFinite(lastContentLine)
      ? textLines.slice(firstContentLine, lastContentLine + 1)
      : [];

  return {
    id,
    timestamp: timestamp.trim(),
    text: boundedTextLines.join("\n"),
  };
}

export function parseTimestamp(timestamps: string) {
  const [start = "", end = ""] = timestamps
    .split(/\s*-->\s*/)
    .map((part) => part.trim());
  return { start, end };
}