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

export function timestampToMs(ts: string): number {
  const parts = ts.split(":");
  if (parts.length !== 3) return 0;
  const [hours, minutes, rest] = parts;
  const [seconds, ms] = rest.split(/[,.]/);
  return (
    parseInt(hours, 10) * 3600000 +
    parseInt(minutes, 10) * 60000 +
    parseInt(seconds, 10) * 1000 +
    parseInt(ms || "0", 10)
  );
}

export function msToTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const mill = clamped % 1000;
  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},` +
    `${String(mill).padStart(3, "0")}`
  );
}

export function applyOffsetToTimestampLine(
  timestampLine: string,
  offsetMs: number,
): string {
  const { start, end } = parseTimestamp(timestampLine);
  const newStart = msToTimestamp(timestampToMs(start) + offsetMs);
  const newEnd = msToTimestamp(timestampToMs(end) + offsetMs);
  return `${newStart} --> ${newEnd}`;
}