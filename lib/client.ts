import { Segment } from "@/types";

const TIMESTAMP_LINE_REGEX =
  /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/;

export function parseSegment(text: string): Segment {
  const lines = text
    .split(/\r\n|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const timestampIndex = lines.findIndex((line) =>
    TIMESTAMP_LINE_REGEX.test(line),
  );

  let id = Number.NaN;
  if (timestampIndex > 0) {
    id = Number.parseInt(lines[0] ?? "", 10);
  }

  const timestamp = timestampIndex >= 0 ? lines[timestampIndex] : "";
  const textLines = timestampIndex >= 0 ? lines.slice(timestampIndex + 1) : lines;

  return {
    id,
    timestamp: timestamp.trim(),
    text: textLines
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .trim(),
  };
}

export function parseTimestamp(timestamps: string) {
  const [start = "", end = ""] = timestamps
    .split(/\s*-->\s*/)
    .map((part) => part.trim());
  return { start, end };
}