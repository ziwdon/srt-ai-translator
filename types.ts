export interface Chunk {
  index: string;
  start: string;
  end: string;
  text: string;
}

export type Segment = {
  id: number;
  timestamp: string;
  text: string;
};

export type ProhibitedContentPolicy =
  | "keep_original"
  | "placeholder"
  | "redact";

export type TranslationErrorCategory =
  | "prohibited_content"
  | "safety_filter"
  | "content_filter"
  | "prompt_blocked"
  | "segment_mismatch"
  | "timeout"
  | "transient"
  | "network"
  | "unknown";

export type TranslationErrorInfo = {
  category: TranslationErrorCategory;
  retryable: boolean;
  splittable: boolean;
  blockReason?: string;
  providerResponseId?: string;
  message: string;
};

export type TranslationErrorCode =
  | "PROHIBITED_CONTENT"
  | "SAFETY_FILTER"
  | "CONTENT_FILTER"
  | "PROMPT_BLOCKED"
  | "TRANSLATION_ERROR"
  | "INVALID_REQUEST"
  | "CONFIG_ERROR";

export type TranslatedSegmentResult = {
  text: string;
  blocked: boolean;
  originalSegmentId: number;
  blockReason?: string;
  blockPolicy?: ProhibitedContentPolicy;
};

export type TranslationGroupResult = {
  segments: TranslatedSegmentResult[];
  hasBlockedSegments: boolean;
  blockedSegmentIds: number[];
  blockedReasons: string[];
  splitDepth: number;
};