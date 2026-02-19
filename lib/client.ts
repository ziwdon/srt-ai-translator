import { Segment } from "@/types";

export function parseSegment(text: string): Segment {
  const [id, timestamp = "", ...lines] = text.split(/\r\n|\n/);
  return {
    id: Number.parseInt(id?.trim() ?? "", 10),
    timestamp: timestamp.trim(),
    text: lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .trim(),
  };
}

export function parseTimestamp(timestamps: string) {
  const [start = "", end = ""] = timestamps.split(" --> ");
  return { start, end }
}