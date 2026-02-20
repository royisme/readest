import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Segment = {
  text: string;
  index: number;
};

const ENV = {
  enabled: process.env.TTS_LIVE_TEST === '1',
  txtPath: process.env.TTS_LIVE_TXT_PATH || '',
  baseUrl: (process.env.TTS_LIVE_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.TTS_LIVE_API_KEY || '',
  model: process.env.TTS_LIVE_MODEL || 'voxcpm-1.5',
  voice: process.env.TTS_LIVE_VOICE || 'default',
  responseFormat: (process.env.TTS_LIVE_RESPONSE_FORMAT || 'mp3').toLowerCase(),
  preferredMaxChars: Number(process.env.TTS_LIVE_SEGMENT_PREFERRED || 260),
  absoluteMaxChars: Number(process.env.TTS_LIVE_SEGMENT_ABSOLUTE || 500),
  limitSegments: Number(process.env.TTS_LIVE_LIMIT_SEGMENTS || 30),
  outputDir: process.env.TTS_LIVE_OUTPUT_DIR || '',
};

const STRONG_BREAK = new Set(['。', '！', '？', '；', '…', '!', '?', ';']);
const WEAK_BREAK = new Set(['，', '、', ',', '：', ':']);

const normalize = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const tryDecode = (buffer: Buffer, encoding: string): string => {
  try {
    return new TextDecoder(encoding as BufferEncoding, { fatal: false }).decode(buffer);
  } catch {
    return '';
  }
};

const smartDecodeText = (buffer: Buffer): string => {
  const utf8 = tryDecode(buffer, 'utf-8');
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replacementCount === 0) {
    return utf8;
  }

  const gb18030 = tryDecode(buffer, 'gb18030');
  if (gb18030) {
    const gbReplacementCount = (gb18030.match(/\uFFFD/g) || []).length;
    if (gbReplacementCount < replacementCount) {
      return gb18030;
    }
  }

  return utf8;
};

const splitByPunctuation = (paragraph: string): string[] => {
  const result: string[] = [];
  let current = '';

  for (const ch of paragraph) {
    current += ch;
    if (STRONG_BREAK.has(ch)) {
      const value = current.trim();
      if (value) result.push(value);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail) result.push(tail);
  return result;
};

const findSplitPoint = (text: string, limit: number): number => {
  if (text.length <= limit) return text.length;

  let strongPos = -1;
  let weakPos = -1;
  for (let i = 0; i < limit; i++) {
    const ch = text[i]!;
    if (STRONG_BREAK.has(ch)) strongPos = i;
    if (WEAK_BREAK.has(ch)) weakPos = i;
  }

  if (strongPos >= 0) return strongPos + 1;
  if (weakPos >= 0) return weakPos + 1;
  return limit;
};

const splitByHardLimit = (text: string, hardLimit: number): string[] => {
  const parts: string[] = [];
  let rest = text.trim();

  while (rest.length > hardLimit) {
    const idx = findSplitPoint(rest, hardLimit);
    const head = rest.slice(0, idx).trim();
    if (head) parts.push(head);
    rest = rest.slice(idx).trim();
  }

  if (rest) parts.push(rest);
  return parts;
};

const segmentText = (
  text: string,
  preferredMaxChars: number,
  absoluteMaxChars: number,
): Segment[] => {
  const normalized = normalize(text);
  const paragraphs = normalized
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean);

  const segments: Segment[] = [];
  let current = '';

  const flush = () => {
    const value = current.trim();
    if (!value) return;
    segments.push({ text: value, index: segments.length });
    current = '';
  };

  for (const paragraph of paragraphs) {
    const sentenceLike = splitByPunctuation(paragraph);
    const pieces = sentenceLike.length > 0 ? sentenceLike : [paragraph];

    for (const pieceRaw of pieces) {
      const pieceParts = splitByHardLimit(pieceRaw, absoluteMaxChars);
      for (const piece of pieceParts) {
        if (!current) {
          current = piece;
          continue;
        }

        const candidate = `${current}${piece}`;
        if (candidate.length <= preferredMaxChars) {
          current = candidate;
          continue;
        }

        flush();
        current = piece;
      }
    }

    flush();
  }

  flush();
  return segments;
};

const must = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

describe('Remote TTS txt live smoke', () => {
  it.skipIf(!ENV.enabled)('should generate playable audio clips from txt content', async () => {
    must(ENV.txtPath, 'Missing TTS_LIVE_TXT_PATH');
    must(ENV.baseUrl, 'Missing TTS_LIVE_BASE_URL');

    const fullPath = resolve(ENV.txtPath);
    const content = smartDecodeText(await readFile(fullPath));
    const segments = segmentText(content, ENV.preferredMaxChars, ENV.absoluteMaxChars).slice(
      0,
      ENV.limitSegments,
    );

    must(segments.length > 0, 'No segment generated from txt');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir =
      ENV.outputDir ||
      resolve(process.cwd(), '.works', 'tts-live-output', `${basename(fullPath)}-${timestamp}`);
    await mkdir(outputDir, { recursive: true });

    const playlist: string[] = ['#EXTM3U'];
    const requestLog: Array<{ index: number; chars: number; ms: number; file: string }> = [];

    for (const segment of segments) {
      const startedAt = Date.now();
      const response = await fetch(`${ENV.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ENV.apiKey ? { Authorization: `Bearer ${ENV.apiKey}` } : {}),
        },
        body: JSON.stringify({
          input: segment.text,
          model: ENV.model,
          voice: ENV.voice,
          response_format: ENV.responseFormat,
          speed: 1.0,
          stream: false,
        }),
      });

      if (!response.ok) {
        const textErr = await response.text();
        throw new Error(
          `TTS request failed at segment ${segment.index}: HTTP ${response.status} ${textErr}`,
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);

      const ext =
        ENV.responseFormat === 'wav' ? 'wav' : ENV.responseFormat === 'pcm' ? 'pcm' : 'mp3';
      const fileName = `${String(segment.index + 1).padStart(4, '0')}.${ext}`;
      await writeFile(resolve(outputDir, fileName), bytes);

      const elapsed = Date.now() - startedAt;
      requestLog.push({
        index: segment.index,
        chars: segment.text.length,
        ms: elapsed,
        file: fileName,
      });
      playlist.push(`#EXTINF:-1,segment-${segment.index + 1}`);
      playlist.push(fileName);
    }

    await writeFile(resolve(outputDir, 'playlist.m3u'), `${playlist.join('\n')}\n`, 'utf-8');
    await writeFile(
      resolve(outputDir, 'request-log.json'),
      JSON.stringify(
        {
          txtPath: fullPath,
          baseUrl: ENV.baseUrl,
          model: ENV.model,
          voice: ENV.voice,
          responseFormat: ENV.responseFormat,
          preferredMaxChars: ENV.preferredMaxChars,
          absoluteMaxChars: ENV.absoluteMaxChars,
          generatedSegments: segments.length,
          requestLog,
        },
        null,
        2,
      ),
      'utf-8',
    );

    console.log(`Live TTS output written to: ${outputDir}`);
    expect(requestLog.length).toBe(segments.length);
  });
});
