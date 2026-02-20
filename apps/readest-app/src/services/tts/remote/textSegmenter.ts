import { TTSMark } from '../types';

export type RemoteTTSSegment = {
  text: string;
  language: string;
  anchorMark: TTSMark;
};

export type RemoteTTSSegmentOptions = {
  preferredMaxChars: number;
  absoluteMaxChars: number;
  minCharsPerSegment: number;
};

const DEFAULT_OPTIONS: RemoteTTSSegmentOptions = {
  preferredMaxChars: 90,
  absoluteMaxChars: 500,
  minCharsPerSegment: 40,
};

const STRONG_BREAK_CHARS = new Set(['。', '！', '？', '；', '…', '!', '?', ';']);
const WEAK_BREAK_CHARS = new Set(['，', '、', ',', '：', ':']);

const normalizeText = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

const needSpaceBetween = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  const leftLast = left[left.length - 1]!;
  const rightFirst = right[0]!;

  const leftIsWord = /[A-Za-z0-9]$/.test(leftLast);
  const rightIsWord = /^[A-Za-z0-9]/.test(rightFirst);
  const leftIsLatinSentenceEnd = /[.!?]/.test(leftLast);
  return (leftIsWord && rightIsWord) || (leftIsLatinSentenceEnd && rightIsWord);
};

const concatText = (left: string, right: string): string => {
  if (!left) return right;
  if (!right) return left;
  return needSpaceBetween(left, right) ? `${left} ${right}` : `${left}${right}`;
};

const pickBestBreakIndex = (text: string, limit: number): number => {
  if (text.length <= limit) return text.length;

  let strongIdx = -1;
  let weakIdx = -1;
  for (let i = 0; i < limit; i++) {
    const ch = text[i]!;
    if (STRONG_BREAK_CHARS.has(ch)) {
      strongIdx = i;
    } else if (WEAK_BREAK_CHARS.has(ch)) {
      weakIdx = i;
    }
  }

  if (strongIdx >= 0) return strongIdx + 1;
  if (weakIdx >= 0) return weakIdx + 1;
  return limit;
};

const splitByAbsoluteLimit = (text: string, absoluteMaxChars: number): string[] => {
  const chunks: string[] = [];
  let remaining = normalizeText(text);

  while (remaining.length > absoluteMaxChars) {
    const idx = pickBestBreakIndex(remaining, absoluteMaxChars);
    const head = normalizeText(remaining.slice(0, idx));
    if (head) {
      chunks.push(head);
    }
    remaining = normalizeText(remaining.slice(idx));
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
};

const withDefaults = (options?: Partial<RemoteTTSSegmentOptions>): RemoteTTSSegmentOptions => {
  const merged: RemoteTTSSegmentOptions = {
    preferredMaxChars: options?.preferredMaxChars ?? DEFAULT_OPTIONS.preferredMaxChars,
    absoluteMaxChars: options?.absoluteMaxChars ?? DEFAULT_OPTIONS.absoluteMaxChars,
    minCharsPerSegment: options?.minCharsPerSegment ?? DEFAULT_OPTIONS.minCharsPerSegment,
  };

  if (merged.preferredMaxChars > merged.absoluteMaxChars) {
    merged.preferredMaxChars = merged.absoluteMaxChars;
  }

  if (merged.minCharsPerSegment > merged.preferredMaxChars) {
    merged.minCharsPerSegment = Math.max(1, Math.floor(merged.preferredMaxChars / 2));
  }

  return merged;
};

export const buildRemoteTTSSegments = (
  marks: TTSMark[],
  options?: Partial<RemoteTTSSegmentOptions>,
): RemoteTTSSegment[] => {
  const { preferredMaxChars, absoluteMaxChars, minCharsPerSegment } = withDefaults(options);
  const segments: RemoteTTSSegment[] = [];

  let currentText = '';
  let currentAnchor: TTSMark | null = null;

  const flush = () => {
    const text = normalizeText(currentText);
    if (!text || !currentAnchor) {
      currentText = '';
      currentAnchor = null;
      return;
    }
    segments.push({
      text,
      language: currentAnchor.language,
      anchorMark: currentAnchor,
    });
    currentText = '';
    currentAnchor = null;
  };

  const appendPiece = (piece: string, anchor: TTSMark) => {
    const normalizedPiece = normalizeText(piece);
    if (!normalizedPiece) return;

    if (!currentText) {
      currentText = normalizedPiece;
      currentAnchor = anchor;
      return;
    }

    const candidate = concatText(currentText, normalizedPiece);
    if (candidate.length <= preferredMaxChars) {
      currentText = candidate;
      return;
    }

    if (currentText.length < minCharsPerSegment && candidate.length <= absoluteMaxChars) {
      currentText = candidate;
      return;
    }

    flush();
    currentText = normalizedPiece;
    currentAnchor = anchor;
  };

  const perPieceLimit = Math.min(preferredMaxChars, absoluteMaxChars);

  for (const mark of marks) {
    const pieces = splitByAbsoluteLimit(mark.text, perPieceLimit);
    for (const piece of pieces) {
      appendPiece(piece, mark);
    }
  }

  flush();
  return segments;
};
