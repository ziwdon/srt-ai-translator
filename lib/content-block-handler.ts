import type {
  ProhibitedContentPolicy,
  Segment,
  TranslatedSegmentResult,
  TranslationErrorCategory,
  TranslationErrorCode,
  TranslationErrorInfo,
} from "@/types";

const NORMAL_FINISH_REASONS = new Set(["STOP", "MAX_TOKENS", "LENGTH"]);

const PROMPT_BLOCK_REASON_TO_CATEGORY: Record<string, TranslationErrorCategory> = {
  PROHIBITED_CONTENT: "prohibited_content",
  BLOCKED_REASON_UNSPECIFIED: "prompt_blocked",
  OTHER: "prompt_blocked",
};

const FINISH_REASON_TO_CATEGORY: Record<string, TranslationErrorCategory> = {
  PROHIBITED_CONTENT: "prohibited_content",
  SAFETY: "safety_filter",
  RECITATION: "content_filter",
  SPII: "content_filter",
  BLOCKLIST: "content_filter",
  MODEL_ARMOR: "content_filter",
  CONTENT_FILTER: "content_filter",
  BLOCKED_REASON_UNSPECIFIED: "prompt_blocked",
  OTHER: "prompt_blocked",
};

const CONTENT_BLOCK_CATEGORIES = new Set<TranslationErrorCategory>([
  "prohibited_content",
  "safety_filter",
  "content_filter",
  "prompt_blocked",
]);

type ErrorWithTranslationInfo = Error & {
  translationErrorInfo?: TranslationErrorInfo;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeReason(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function getStatusCode(errorRecord: Record<string, unknown>): number | undefined {
  const directStatus = errorRecord.statusCode;
  if (typeof directStatus === "number" && Number.isFinite(directStatus)) {
    return directStatus;
  }

  const cause = errorRecord.cause;
  if (isRecord(cause)) {
    const nestedStatus = cause.statusCode;
    if (typeof nestedStatus === "number" && Number.isFinite(nestedStatus)) {
      return nestedStatus;
    }
  }

  return undefined;
}

function parseResponseBody(errorRecord: Record<string, unknown>): Record<string, unknown> | null {
  const responseBody = errorRecord.responseBody;

  if (isRecord(responseBody)) {
    return responseBody;
  }

  if (typeof responseBody !== "string" || !responseBody.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(responseBody) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractProviderResponseId(payload: Record<string, unknown>): string | undefined {
  const responseId = getString(payload.responseId);
  if (responseId) {
    return responseId;
  }

  const response = payload.response;
  if (isRecord(response)) {
    return getString(response.id);
  }

  return undefined;
}

function classifyPromptBlockReason(
  reason: string | undefined,
): TranslationErrorCategory | null {
  if (!reason) {
    return null;
  }

  return PROMPT_BLOCK_REASON_TO_CATEGORY[reason] ?? null;
}

function classifyFinishReasonCategory(
  reason: string | undefined,
): TranslationErrorCategory | null {
  if (!reason || NORMAL_FINISH_REASONS.has(reason)) {
    return null;
  }

  return FINISH_REASON_TO_CATEGORY[reason] ?? null;
}

function classifyFromProviderPayload(
  payload: Record<string, unknown>,
): { category: TranslationErrorCategory; blockReason: string; providerResponseId?: string } | null {
  const providerResponseId = extractProviderResponseId(payload);

  const promptFeedback = payload.promptFeedback;
  if (isRecord(promptFeedback)) {
    const promptReason = normalizeReason(getString(promptFeedback.blockReason));
    const promptCategory = classifyPromptBlockReason(promptReason);
    if (promptReason && promptCategory) {
      return {
        category: promptCategory,
        blockReason: promptReason,
        providerResponseId,
      };
    }
  }

  const directFinishReason = normalizeReason(getString(payload.finishReason));
  const directFinishCategory = classifyFinishReasonCategory(directFinishReason);
  if (directFinishReason && directFinishCategory) {
    return {
      category: directFinishCategory,
      blockReason: directFinishReason,
      providerResponseId,
    };
  }

  const candidates = payload.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (!isRecord(candidate)) {
        continue;
      }

      const candidateReason = normalizeReason(getString(candidate.finishReason));
      const candidateCategory = classifyFinishReasonCategory(candidateReason);
      if (candidateReason && candidateCategory) {
        return {
          category: candidateCategory,
          blockReason: candidateReason,
          providerResponseId,
        };
      }
    }
  }

  return null;
}

function buildContentBlockInfo(
  category: TranslationErrorCategory,
  blockReason: string,
  message: string,
  providerResponseId?: string,
): TranslationErrorInfo {
  return {
    category,
    retryable: false,
    splittable: true,
    blockReason,
    providerResponseId,
    message,
  };
}

function extractCauseChain(errorRecord: Record<string, unknown>): Record<string, unknown>[] {
  const causes: Record<string, unknown>[] = [];
  let cursor: unknown = errorRecord.cause;

  while (isRecord(cursor)) {
    causes.push(cursor);
    cursor = cursor.cause;
  }

  return causes;
}

function containsOneOf(target: string, needles: string[]): string | undefined {
  const normalizedTarget = target.toUpperCase();
  return needles.find((needle) => normalizedTarget.includes(needle));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown translation error.";
}

function toErrorInstance(error: unknown): ErrorWithTranslationInfo {
  if (error instanceof Error) {
    return error as ErrorWithTranslationInfo;
  }

  return new Error(getErrorMessage(error));
}

export function isContentBlockCategory(category: TranslationErrorCategory): boolean {
  return CONTENT_BLOCK_CATEGORIES.has(category);
}

export function classifyFinishReason(
  finishReason: string | null | undefined,
  providerResponseId?: string,
): TranslationErrorInfo | null {
  const normalizedReason = normalizeReason(finishReason ?? undefined);
  if (!normalizedReason) {
    return null;
  }

  const category = classifyFinishReasonCategory(normalizedReason);
  if (!category) {
    return null;
  }

  return buildContentBlockInfo(
    category,
    normalizedReason,
    `Model finished with ${normalizedReason}.`,
    providerResponseId,
  );
}

export function classifyTranslationError(error: unknown): TranslationErrorInfo {
  const attachedInfo = getTranslationErrorInfo(error);
  if (attachedInfo) {
    return attachedInfo;
  }

  const message = getErrorMessage(error);
  if (!isRecord(error)) {
    return {
      category: "unknown",
      retryable: true,
      splittable: false,
      message,
    };
  }

  const errorRecord = error;
  const payloadCandidates: Record<string, unknown>[] = [];

  const parsedBody = parseResponseBody(errorRecord);
  if (parsedBody) {
    payloadCandidates.push(parsedBody);
  }

  const causes = extractCauseChain(errorRecord);
  for (const cause of causes) {
    const parsedCauseBody = parseResponseBody(cause);
    if (parsedCauseBody) {
      payloadCandidates.push(parsedCauseBody);
    }

    const causeValue = cause.value;
    if (isRecord(causeValue)) {
      payloadCandidates.push(causeValue);
    }
  }

  const directValue = errorRecord.value;
  if (isRecord(directValue)) {
    payloadCandidates.push(directValue);
  }

  for (const payload of payloadCandidates) {
    const providerClassification = classifyFromProviderPayload(payload);
    if (providerClassification) {
      return buildContentBlockInfo(
        providerClassification.category,
        providerClassification.blockReason,
        message,
        providerClassification.providerResponseId,
      );
    }
  }

  const responseBody = getString(errorRecord.responseBody) ?? "";
  const fallbackText = `${message}\n${responseBody}`.toUpperCase();

  const matchedPromptReason = containsOneOf(fallbackText, [
    "PROHIBITED_CONTENT",
    "BLOCKED_REASON_UNSPECIFIED",
    "SAFETY",
    "RECITATION",
    "SPII",
    "BLOCKLIST",
    "MODEL_ARMOR",
    "CONTENT_FILTER",
  ]);

  if (matchedPromptReason) {
    const normalizedReason = normalizeReason(matchedPromptReason);
    const category =
      classifyPromptBlockReason(normalizedReason) ??
      classifyFinishReasonCategory(normalizedReason) ??
      "content_filter";
    if (normalizedReason) {
      return buildContentBlockInfo(category, normalizedReason, message);
    }
  }

  if (
    /expected\s+\d+\s+segments?.*received\s+\d+/i.test(message) ||
    /unexpected translated output shape/i.test(message)
  ) {
    return {
      category: "segment_mismatch",
      retryable: true,
      splittable: false,
      message,
    };
  }

  const errorName = getString(errorRecord.name) ?? "";
  const errorCode = getString(errorRecord.code) ?? "";
  if (
    errorName === "AbortError" ||
    errorCode === "ABORT_ERR" ||
    /timed?\s*out/i.test(message) ||
    /aborted/i.test(message)
  ) {
    return {
      category: "timeout",
      retryable: true,
      splittable: false,
      message,
    };
  }

  const statusCode = getStatusCode(errorRecord);
  if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500 && statusCode < 600)) {
    return {
      category: "transient",
      retryable: true,
      splittable: false,
      message,
    };
  }

  if (
    errorName === "TypeError" &&
    /(fetch failed|network|econn|socket|connection|enotfound|eai_again)/i.test(message)
  ) {
    return {
      category: "network",
      retryable: true,
      splittable: false,
      message,
    };
  }

  return {
    category: "unknown",
    retryable: true,
    splittable: false,
    message,
  };
}

export function attachTranslationErrorInfo(
  error: unknown,
  info: TranslationErrorInfo,
): ErrorWithTranslationInfo {
  const errorInstance = toErrorInstance(error);
  errorInstance.translationErrorInfo = info;
  return errorInstance;
}

export function getTranslationErrorInfo(error: unknown): TranslationErrorInfo | null {
  if (!isRecord(error)) {
    return null;
  }

  const candidate = error.translationErrorInfo;
  if (!isRecord(candidate)) {
    return null;
  }

  const category = candidate.category;
  const retryable = candidate.retryable;
  const splittable = candidate.splittable;
  const message = candidate.message;

  if (
    typeof category === "string" &&
    typeof retryable === "boolean" &&
    typeof splittable === "boolean" &&
    typeof message === "string"
  ) {
    return {
      category: category as TranslationErrorCategory,
      retryable,
      splittable,
      blockReason: getString(candidate.blockReason),
      providerResponseId: getString(candidate.providerResponseId),
      message,
    };
  }

  return null;
}

export function translationErrorCategoryToCode(
  category: TranslationErrorCategory,
): TranslationErrorCode {
  switch (category) {
    case "prohibited_content":
      return "PROHIBITED_CONTENT";
    case "safety_filter":
      return "SAFETY_FILTER";
    case "content_filter":
      return "CONTENT_FILTER";
    case "prompt_blocked":
      return "PROMPT_BLOCKED";
    default:
      return "TRANSLATION_ERROR";
  }
}

export function applyIrreducibleBlockPolicy(
  segment: Segment,
  policy: ProhibitedContentPolicy,
  placeholder: string,
  blockReason?: string,
): TranslatedSegmentResult {
  let text: string;

  switch (policy) {
    case "placeholder":
      text = placeholder;
      break;
    case "redact":
      text = "";
      break;
    case "keep_original":
    default:
      text = segment.text;
      break;
  }

  return {
    text,
    blocked: true,
    originalSegmentId: segment.id,
    blockReason,
    blockPolicy: policy,
  };
}
