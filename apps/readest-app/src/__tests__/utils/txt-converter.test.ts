// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { TxtToEpubConverter } from '@/utils/txt';

type TestChapter = {
  title: string;
  content: string;
  isVolume: boolean;
};

type TestMetadata = {
  bookTitle: string;
  author: string;
  language: string;
  identifier: string;
};

type TxtConverterPrivateAPI = {
  detectEncoding(buffer: ArrayBuffer): string | undefined;
  createEpub(chapters: TestChapter[], metadata: TestMetadata): Promise<Blob>;
};

type TxtConverterFlowPrivateAPI = TxtConverterPrivateAPI & {
  convert(options: { file: File; author?: string; language?: string }): Promise<{
    chapterCount: number;
  }>;
  extractChapters(
    txtContent: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): TestChapter[];
  probeChapterCount(
    txtContent: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): number;
  iterateSegmentsFromFile(
    file: File,
    encoding: string,
    linesBetweenSegments: number,
  ): AsyncGenerator<string>;
  detectEncodingFromFile(file: File): Promise<string | undefined>;
  extractChaptersFromFileBySegments(
    file: File,
    encoding: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): Promise<TestChapter[]>;
  probeChapterCountFromFileBySegments(
    file: File,
    encoding: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): Promise<number>;
};

const getBufferSize = (input?: BufferSource): number => {
  if (!input) return 0;
  return input instanceof ArrayBuffer ? input.byteLength : input.byteLength;
};

describe('TxtToEpubConverter', () => {
  it('convert should choose 8 -> 7 when probe detects multiple chapters', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const calls: number[] = [];

    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    converter.extractChapters = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      if (option.linesBetweenSegments === 8) {
        return [{ title: 'Only', content: 'c', isVolume: false }];
      }
      if (option.linesBetweenSegments === 7) {
        return [
          { title: 'A', content: 'a', isVolume: false },
          { title: 'B', content: 'b', isVolume: false },
        ];
      }
      return [{ title: 'Fallback', content: 'f', isVolume: false }];
    };
    converter.probeChapterCount = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      return 2;
    };

    const file = new File(['dummy content'], 'sample.txt');
    const result = await converter.convert({ file });

    expect(calls).toEqual([8, 7, 7]);
    expect(result.chapterCount).toBe(2);
  });

  it('convert should choose 8 -> 6 when probe does not detect multiple chapters', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const calls: number[] = [];

    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    converter.extractChapters = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      if (option.linesBetweenSegments === 8) {
        return [{ title: 'Only', content: 'c', isVolume: false }];
      }
      if (option.linesBetweenSegments === 6) {
        return [
          { title: 'A', content: 'a', isVolume: false },
          { title: 'B', content: 'b', isVolume: false },
        ];
      }
      return [{ title: 'Single', content: 's', isVolume: false }];
    };
    converter.probeChapterCount = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      return 1;
    };

    const file = new File(['dummy content'], 'sample.txt');
    const result = await converter.convert({ file });

    expect(calls).toEqual([8, 7, 6]);
    expect(result.chapterCount).toBe(2);
  });

  it('detectEncoding should probe UTF-8 with sampled buffers only', () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterPrivateAPI;
    const fullSize = 220 * 1024;
    const buffer = new TextEncoder().encode('a'.repeat(fullSize)).buffer;

    const OriginalTextDecoder = globalThis.TextDecoder;
    const decodeSizes: number[] = [];

    class RecordingTextDecoder extends OriginalTextDecoder {
      override decode(input?: BufferSource, options?: TextDecodeOptions): string {
        decodeSizes.push(getBufferSize(input));
        return super.decode(input, options);
      }
    }

    (globalThis as { TextDecoder: typeof TextDecoder }).TextDecoder =
      RecordingTextDecoder as typeof TextDecoder;
    try {
      expect(converter.detectEncoding(buffer)).toBe('utf-8');
    } finally {
      (globalThis as { TextDecoder: typeof TextDecoder }).TextDecoder = OriginalTextDecoder;
    }

    expect(Math.max(...decodeSizes)).toBeLessThanOrEqual(64 * 1024);
    expect(decodeSizes).toContain(8192);
    expect(decodeSizes).not.toContain(fullSize);
  });

  it('detectEncoding should keep utf-8 when sample boundaries split multibyte chars', () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterPrivateAPI;
    const text = `开头\n${'汉字'.repeat(60000)}\n结尾`;
    const buffer = new TextEncoder().encode(text).buffer;

    expect(converter.detectEncoding(buffer)).toBe('utf-8');
  });

  it('createEpub should use metadata language for chapter lang attributes', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterPrivateAPI;
    const chapters: TestChapter[] = [
      {
        title: 'Chapter 1',
        content: '<h2>Chapter 1</h2><p>Hello world</p>',
        isVolume: false,
      },
    ];
    const metadata: TestMetadata = {
      bookTitle: 'Sample Book',
      author: 'Sample Author',
      language: 'zh',
      identifier: 'sample-id',
    };

    const blob = await converter.createEpub(chapters, metadata);
    const { ZipReader, BlobReader, TextWriter } = await import('@zip.js/zip.js');
    const reader = new ZipReader(new BlobReader(blob));
    try {
      const entries = await reader.getEntries();
      const chapterEntry = entries.find((entry) => entry.filename === 'OEBPS/chapter1.xhtml');
      expect(chapterEntry).toBeDefined();
      const chapterContent = await chapterEntry!.getData(new TextWriter());
      expect(chapterContent).toContain('lang="zh"');
      expect(chapterContent).toContain('xml:lang="zh"');
    } finally {
      await reader.close();
    }
  });

  it('iterateSegmentsFromFile should split by 8 newlines across chunk boundaries', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const CHUNK_SIZE = 512 * 1024;
    const head = `Segment A${'x'.repeat(CHUNK_SIZE - 'Segment A'.length - 4)}`;
    const content = new Blob([`${head}\n\n\n\n\n\n\n\nSegment B`]);
    const file = {
      size: content.size,
      slice: (start?: number, end?: number) => content.slice(start, end),
    } as unknown as File;

    const segments: string[] = [];
    for await (const segment of converter.iterateSegmentsFromFile(file, 'utf-8', 8)) {
      segments.push(segment);
    }

    expect(segments).toHaveLength(2);
    expect(segments[0]?.startsWith('Segment A')).toBe(true);
    expect(segments[1]).toBe('Segment B');
  });

  it('convert should use chunked path for large files without calling file.arrayBuffer', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const calls: number[] = [];
    let arrayBufferCalled = false;
    const backingBlob = new Blob(['Header line\n\n\n\n\n\n\n\nChapter content']);

    const largeFile = {
      name: 'large.txt',
      size: 9 * 1024 * 1024,
      slice: (start?: number, end?: number) => backingBlob.slice(start, end),
      stream: () => backingBlob.stream(),
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        throw new Error('large path should not call file.arrayBuffer');
      },
    } as unknown as File;

    converter.detectEncodingFromFile = async () => 'utf-8';
    converter.createEpub = async () => new Blob();
    converter.extractChaptersFromFileBySegments = async (_, __, ___, option) => {
      calls.push(option.linesBetweenSegments);
      if (option.linesBetweenSegments === 8) {
        return [{ title: 'Only', content: 'c', isVolume: false }];
      }
      if (option.linesBetweenSegments === 7) {
        return [
          { title: 'A', content: 'a', isVolume: false },
          { title: 'B', content: 'b', isVolume: false },
        ];
      }
      return [{ title: 'Fallback', content: 'f', isVolume: false }];
    };
    converter.probeChapterCountFromFileBySegments = async (_, __, ___, option) => {
      calls.push(option.linesBetweenSegments);
      return 2;
    };

    const result = await converter.convert({ file: largeFile });

    expect(arrayBufferCalled).toBe(false);
    expect(calls).toEqual([8, 7, 7]);
    expect(result.chapterCount).toBe(2);
  });

  it('convert large file should execute real chunked extraction without file.arrayBuffer', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    let arrayBufferCalled = false;
    const backingBlob = new Blob(['Segment A\n\n\n\n\n\n\n\nSegment B']);

    const largeFile = {
      name: 'large.txt',
      size: 9 * 1024 * 1024,
      slice: (start?: number, end?: number) => backingBlob.slice(start, end),
      stream: () => backingBlob.stream(),
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        throw new Error('large path should not call file.arrayBuffer');
      },
    } as unknown as File;

    converter.createEpub = async () => new Blob();

    const result = await converter.convert({ file: largeFile });

    expect(arrayBufferCalled).toBe(false);
    expect(result.chapterCount).toBe(2);
  });

  it('iterateSegmentsFromFile should stop cleanly on early return', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI & {
      iterateSegmentsFromFile(
        file: File,
        encoding: string,
        linesBetweenSegments: number,
      ): AsyncGenerator<string>;
    };
    const content = new Blob(['Segment A\n\n\n\n\n\n\n\nSegment B']);
    const file = {
      size: content.size,
      slice: (start?: number, end?: number) => content.slice(start, end),
    } as unknown as File;

    const iterator = converter.iterateSegmentsFromFile(file, 'utf-8', 8);
    const first = await iterator.next();
    expect(first.value).toBe('Segment A');
    const done = await iterator.return(undefined);
    expect(done.done).toBe(true);
  });

  it.runIf(Boolean(process.env.TXT_SAMPLE_PATH))(
    'convert should handle real-world large UTF-8 TXT sample',
    async () => {
      const samplePath = process.env.TXT_SAMPLE_PATH!;
      const buffer = await readFile(samplePath);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const file = new File([bytes], basename(samplePath), { type: 'text/plain' });
      const converter = new TxtToEpubConverter();

      const result = await converter.convert({ file });

      expect(result.chapterCount).toBeGreaterThan(0);
      expect(result.file.name.toLowerCase().endsWith('.epub')).toBe(true);
      expect(result.file.size).toBeGreaterThan(0);
    },
  );

  it.runIf(Boolean(process.env.TXT_SAMPLE_PATH))(
    'analyze chapter structure for real-world TXT sample',
    async () => {
      const samplePath = process.env.TXT_SAMPLE_PATH!;
      const buffer = await readFile(samplePath);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const file = new File([bytes], basename(samplePath), { type: 'text/plain' });
      const converter = new TxtToEpubConverter();

      const result = await converter.convert({ file });
      const { ZipReader, BlobReader, TextWriter } = await import('@zip.js/zip.js');
      const reader = new ZipReader(new BlobReader(result.file));
      try {
        const entries = await reader.getEntries();
        const tocEntry = entries.find((entry) => entry.filename === 'toc.ncx');
        expect(tocEntry).toBeDefined();
        const toc = await tocEntry!.getData(new TextWriter());

        const titleMatches = Array.from(toc.matchAll(/<navLabel><text>(.*?)<\/text><\/navLabel>/g));
        const titles = titleMatches.map((m) => (m[1] || '').trim()).filter(Boolean);

        const chapterEntries = entries.filter((entry) => /^OEBPS\/chapter\d+\.xhtml$/.test(entry.filename));
        const emptyTitleCount = titles.filter((t) => t.length === 0).length;
        const numberedTitleCount = titles.filter((t) => /^\d+$/.test(t)).length;

        console.log(
          `[txt-structure] sample=${basename(samplePath)} chapters=${titles.length} files=${chapterEntries.length} numbered_titles=${numberedTitleCount} empty_titles=${emptyTitleCount} first10=${titles.slice(0, 10).join(' | ')}`,
        );

        expect(titles.length).toBeGreaterThan(10);
        expect(chapterEntries.length).toBe(titles.length);
      } finally {
        await reader.close();
      }
    },
  );
});
