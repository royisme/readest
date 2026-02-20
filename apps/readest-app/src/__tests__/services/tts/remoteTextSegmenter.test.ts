import { describe, expect, it } from 'vitest';
import { buildRemoteTTSSegments } from '@/services/tts/remote/textSegmenter';
import { TTSMark } from '@/services/tts/types';

const mark = (name: string, text: string): TTSMark => ({
  name,
  text,
  offset: 0,
  language: 'zh-CN',
});

describe('buildRemoteTTSSegments', () => {
  it('should merge short adjacent marks into larger segments', () => {
    const marks = [
      mark('0', '第一句。'),
      mark('1', '第二句。'),
      mark('2', '第三句。'),
      mark('3', '第四句。'),
    ];

    const segments = buildRemoteTTSSegments(marks, {
      preferredMaxChars: 12,
      absoluteMaxChars: 500,
      minCharsPerSegment: 6,
    });

    expect(segments.map((s) => s.text)).toEqual(['第一句。第二句。', '第三句。第四句。']);
    expect(segments[0]?.anchorMark.name).toBe('0');
    expect(segments[1]?.anchorMark.name).toBe('2');
  });

  it('should keep each segment within absolute max chars', () => {
    const longText = `${'甲'.repeat(320)}。${'乙'.repeat(320)}。`;
    const marks = [mark('0', longText)];

    const segments = buildRemoteTTSSegments(marks, {
      preferredMaxChars: 260,
      absoluteMaxChars: 500,
      minCharsPerSegment: 120,
    });

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.text.length).toBeLessThanOrEqual(500);
    }
  });

  it('should split by strong punctuation before hitting hard limit', () => {
    const marks = [
      mark('0', `${'甲'.repeat(120)}。`),
      mark('1', `${'乙'.repeat(120)}。`),
      mark('2', `${'丙'.repeat(120)}。`),
    ];

    const segments = buildRemoteTTSSegments(marks, {
      preferredMaxChars: 260,
      absoluteMaxChars: 500,
      minCharsPerSegment: 100,
    });

    expect(segments.length).toBe(2);
    expect(segments[0]?.text.endsWith('。')).toBe(true);
    expect(segments[0]?.anchorMark.name).toBe('0');
    expect(segments[1]?.anchorMark.name).toBe('2');
  });

  it('should ignore empty marks after normalization', () => {
    const marks = [mark('0', '  '), mark('1', '\n\n'), mark('2', '有效文本。')];

    const segments = buildRemoteTTSSegments(marks);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('有效文本。');
    expect(segments[0]?.anchorMark.name).toBe('2');
  });

  it('should keep whitespace between latin words when merging', () => {
    const marks = [
      mark('0', 'Hello'),
      mark('1', 'world.'),
      mark('2', 'How'),
      mark('3', 'are you?'),
    ];
    const segments = buildRemoteTTSSegments(marks, {
      preferredMaxChars: 64,
      absoluteMaxChars: 500,
      minCharsPerSegment: 8,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('Hello world. How are you?');
  });
});
