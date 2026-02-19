import type { Segment } from "@/types";

const DEFAULT_CHARS_PER_TOKEN = 4;
const DELIMITER_TOKEN_COST = 1;

function estimateTokenCount(text: string): number {
	// For chunk sizing we only need a stable estimate, not exact model tokenization.
	return Math.max(1, Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN));
}

/**
 * Groups subtitle segments into batches that stay under `length` estimated tokens.
 */
export function groupSegmentsByTokenLength(
	segments: Segment[],
	length: number,
): Segment[][] {
	const maxTokensPerGroup = Math.max(1, length);
	const groups: Segment[][] = [];
	let currentGroup: Segment[] = [];
	let currentGroupTokenCount = 0;

	for (const segment of segments) {
		const segmentTokenCount = estimateTokenCount(segment.text);

		if (segmentTokenCount >= maxTokensPerGroup) {
			if (currentGroup.length > 0) {
				groups.push(currentGroup);
				currentGroup = [];
				currentGroupTokenCount = 0;
			}
			groups.push([segment]);
			continue;
		}

		const projectedTokenCount =
			currentGroupTokenCount === 0
				? segmentTokenCount
				: currentGroupTokenCount + DELIMITER_TOKEN_COST + segmentTokenCount;

		if (projectedTokenCount <= maxTokensPerGroup) {
			currentGroup.push(segment);
			currentGroupTokenCount = projectedTokenCount;
			continue;
		}

		if (currentGroup.length > 0) {
			groups.push(currentGroup);
		}
		currentGroup = [segment];
		currentGroupTokenCount = segmentTokenCount;
	}

	if (currentGroup.length > 0) {
		groups.push(currentGroup);
	}

	return groups;
}
