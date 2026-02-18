# iOS 大文件 TXT 导入卡死问题分析与解决方案

> **日期**: 2025-02-17
> **问题**: iOS 版本导入 30MB+ TXT 文件时卡死无法解析
> **严重度**: P0 — 功能完全不可用

---

## 1. 问题描述

在 iOS 版本中，导入大文件（如 30MB 的 TXT 文件）时，App 会卡死无法解析。桌面端虽然也慢但通常能完成，iOS 上则直接冻结或崩溃。

---

## 2. 数据流路径

```
用户选择 TXT 文件
  │
  ▼
iOS Files App → copyURIToPath (Swift native bridge)
  │               NativeBridgePlugin.swift
  ▼
NativeFile.open() → 获取文件句柄和元信息
  │                   file.ts:80-86
  ▼
appService.importBook()
  │  apps/readest-app/src/services/appService.ts:342-500
  │
  ├─ 检测 .txt 后缀 (line 374)
  ▼
TxtToEpubConverter.convert()          ← ⚠️ 主要瓶颈区域
  │  apps/readest-app/src/utils/txt.ts:54-101
  │
  ├─ txtFile.arrayBuffer()             ← 🔴 全量读入内存 (line 57)
  ├─ detectEncoding(fileContent)       ← 🟠 30MB 全量解码 (line 58)
  ├─ decoder.decode(fileContent)       ← 🔴 30MB → ~60MB UTF-16 (line 61)
  ├─ extractChapters() × 3 轮         ← 🔴 巨型字符串正则 (line 81-92)
  │   ├─ txtContent.split(segmentRegex)  (line 207)
  │   ├─ segment.split(chapterRegex)     (line 215)
  │   └─ formatSegment() per segment     (line 170-178, 247)
  ├─ createEpub()                      ← 🟠 主线程ZIP (line 94)
  │   ├─ detectLanguage() per chapter    (line 371)
  │   └─ zipWriter.add() per chapter     (line 382-386)
  ▼
DocumentLoader(epubBlob).open()        ← 再次解压 EPUB
  │  apps/readest-app/src/libs/document.ts:195-253
  ▼
partialMD5(fileobj)                    ← ✅ 仅采样，无问题
  │  apps/readest-app/src/utils/md5.ts:11-30
  ▼
书籍加载完成
```

---

## 3. 五个致命瓶颈

### 瓶颈 1：全量文件读入内存 + UTF-16 膨胀

**位置**: `apps/readest-app/src/utils/txt.ts:57-61`

```typescript
const fileContent = await txtFile.arrayBuffer(); // 30MB ArrayBuffer
const detectedEncoding = this.detectEncoding(fileContent) || 'utf-8';
const decoder = new TextDecoder(detectedEncoding);
const txtContent = decoder.decode(fileContent).trim(); // → ~60MB UTF-16 字符串
```

**问题**:

- `arrayBuffer()` 将整个文件一次性读入内存，产生 30MB 的 ArrayBuffer
- `TextDecoder.decode()` 将其转为 JS 字符串，JS 内部用 UTF-16 编码，30MB UTF-8 变成约 60MB
- `.trim()` 可能创建又一份拷贝
- 在 iOS 的 `NativeFile` 实现中，`arrayBuffer()` 调用 `this.slice(0, this.size)`，通过 Tauri IPC 读取整个文件

### 瓶颈 2：编码检测在全量 buffer 上执行

**位置**: `apps/readest-app/src/utils/txt.ts:416-447`

```typescript
private detectEncoding(buffer: ArrayBuffer): string | undefined {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer); // 对 30MB 全量解码!
        return 'utf-8';
    } catch {
        // fallback: 逐段创建 TextDecoder 检测前 10000 字节
        for (let i = 0; i < sampleSize; i++) {
            new TextDecoder('utf-8', { fatal: true }).decode(uint8Array.slice(i, i + 100));
            // ...
        }
    }
}
```

**问题**:

- 首先对整个 30MB buffer 调用一次 `TextDecoder.decode()`（即使只是为了检测编码）
- 如果 UTF-8 解码失败，进入循环逐段检测，每次 `slice` 创建新的 ArrayBuffer

### 瓶颈 3：巨型字符串上的重复正则操作（最多 3 轮）

**位置**: `apps/readest-app/src/utils/txt.ts:81-92, 207-270`

```typescript
// 这个循环最多执行 3 次（i=8,7,6），每次对 ~60MB 字符串做完整章节提取!
for (let i = 8; i >= 6; i--) {
  chapters = this.extractChapters(txtContent, metadata, {
    linesBetweenSegments: i,
    fallbackParagraphsPerChapter: 100,
  });
  if (chapters.length === 0) {
    throw new Error('No chapters detected.');
  } else if (chapters.length > 1) {
    break; // 只有检测到多章才停止
  }
}
```

`extractChapters` 内部的开销链:

```typescript
// 1. 对 ~60MB 字符串做正则 split
const segments = txtContent.split(segmentRegex);

// 2. 每个 segment 再用多个章节正则做 split
for (const segment of segments) {
  for (const chapterRegex of chapterRegexps) {
    const tryMatches = trimmedSegment.split(chapterRegex);
  }
}

// 3. formatSegment() 对每段做:
//    - escapeXml(): 5 次 regex replace
//    - split(/\n+/)
//    - map(line => line.trim())
//    - filter(line => line)
//    - join('</p><p>')
```

**问题**:

- 最坏情况：3 轮 × 全量 split + 多个正则匹配 = 大量 CPU 时间
- JavaScript 正则引擎在 ~60MB 字符串上可能需要数十秒
- 每次 `split()` 创建大量子字符串，产生严重的内存压力

### 瓶颈 4：ZIP 压缩在主线程 + 每章语言检测

**位置**: `apps/readest-app/src/utils/zip.ts:3`

```typescript
configure({ useWebWorkers: false, useCompressionStream: false });
```

**位置**: `apps/readest-app/src/utils/txt.ts:369-386`

```typescript
for (let i = 0; i < chapters.length; i++) {
    const lang = detectLanguage(chapter.text);  // franc 库，每章调用一次
    const chapterContent = `<?xml ...>
        <html lang="${lang}" ...>
          <body>${chapter.content}</body>
        </html>`;
    await zipWriter.add(`OEBPS/chapter${i + 1}.xhtml`, new TextReader(chapterContent), ...);
}
```

**问题**:

- `useWebWorkers: false` 导致 zip 压缩完全在主线程执行
- `detectLanguage()` 内部调用 `franc` 库（基于统计的语言检测），对每个章节都调用一次
- 一本分成几百章的书会调用几百次 `franc`
- `detectLanguage` 已经在 `convert()` 的 line 75 对 fileHeader 调用过一次，这里是重复工作

### 瓶颈 5：整个流水线无 Web Worker

```
项目搜索 "Worker" 的结果：
- sw.ts: ServiceWorker（与文件处理无关）
- zip.ts: 明确禁用 WebWorker (useWebWorkers: false)
- 无其他 Web Worker 使用
```

**所有计算密集型操作都在 WebView 主线程同步执行**:

- JS event loop 被完全阻塞
- UI 无法响应任何触摸事件
- 无法显示加载进度

---

## 4. iOS 特别严重的原因

| 因素             | 桌面                               | iOS                                                            |
| ---------------- | ---------------------------------- | -------------------------------------------------------------- |
| WebView 内存上限 | 几 GB（系统 RAM）                  | ~100-400MB（WKWebView 受 Jetsam 限制）                         |
| 进程被杀         | 极少发生                           | 超过内存预算 iOS 直接终止 Web Content 进程                     |
| JS 引擎性能      | V8(Chromium)/SpiderMonkey(Firefox) | JavaScriptCore，大字符串正则操作更慢                           |
| 主线程阻塞容忍度 | 窗口无响应但系统不会杀进程         | Watchdog 可能判定 App 无响应并终止                             |
| Tauri IPC 开销   | 较低                               | 通过 WKWebView messageHandler 传输，大数据量时有额外序列化开销 |

### 30MB TXT 文件内存峰值估算

| 阶段                         | 内存占用        | 说明                                   |
| ---------------------------- | --------------- | -------------------------------------- |
| ArrayBuffer（原始文件）      | 30 MB           | `txtFile.arrayBuffer()`                |
| detectEncoding 解码          | +30 MB（临时）  | `TextDecoder.decode(buffer)`           |
| txtContent 字符串            | +60 MB          | UTF-16 编码，约为原文件 2 倍           |
| `split(segmentRegex)` 结果   | +30-60 MB       | 子串可能是拷贝而非引用                 |
| 章节正则匹配 + formatSegment | +40-80 MB       | 多次 split/join/replace 产生中间字符串 |
| XHTML 字符串生成             | +20-40 MB       | 每章的 HTML 包装                       |
| ZIP blob                     | +15-25 MB       | 压缩后的 EPUB 数据                     |
| **峰值总计**                 | **~250-400 MB** | 直接触碰 iOS WKWebView 内存上限        |

**结果**:

- 最好情况：UI 卡死数十秒（JS event loop 阻塞）
- 常见情况：WKWebView 进程被 iOS 系统杀死，App 白屏
- 最坏情况：App 被系统终止

---

## 5. 解决方案

### 方案总览

| 方案                 | 解决的根因           | 收益             | 实施难度 | 优先级  |
| -------------------- | -------------------- | ---------------- | -------- | ------- |
| A. Web Worker 卸载   | 主线程阻塞 → UI 卡死 | UI 全程可响应    | 中       | P0 必做 |
| B. 流式/分块文本处理 | 内存爆炸             | 内存降 10 倍+    | 中高     | P0 必做 |
| C. 编码检测采样化    | 30MB 全量解码        | 编码检测瞬间完成 | 低       | P0 必做 |
| D. 章节提取单次化    | 3 轮正则扫描         | CPU 开销降 3 倍  | 低       | P1 建议 |
| E. 语言检测去重      | 每章调 franc         | 减少冗余计算     | 极低     | P1 建议 |
| F. 原生 TXT 渲染器   | 绕过整个 EPUB 转换   | 根本性解决       | 高       | P2 长期 |

---

### 方案 A：Web Worker 卸载

**目标**: 将 `TxtToEpubConverter` 整体搬入 Web Worker，主线程仅做消息传递，UI 全程可响应。

**架构**:

```
主线程 (UI Thread)                    Web Worker
  │                                     │
  │── file.arrayBuffer() ───────────→  │
  │── postMessage(arrayBuffer) ─────→  │
  │                                     │── detectEncoding()
  │   ← progress("检测编码完成") ────── │
  │                                     │── extractChapters()
  │   ← progress("章节提取 60%") ────── │
  │                                     │── createEpub()
  │   ← progress("生成EPUB...") ─────── │
  │                                     │
  │← postMessage(epubBlob) ────────── │
  │                                     │
  UI 全程可响应，可显示进度条
```

**修改点**:

1. 新建 `apps/readest-app/src/workers/txt-worker.ts`，迁入 `TxtToEpubConverter` 逻辑
2. `appService.ts` 中改为通过 Worker 消息调用
3. Worker 内可启用 `useCompressionStream: true`（Worker 内无主线程阻塞顾虑）
4. 通过 `postMessage` 回传进度信息，可在 UI 上显示进度条

**注意事项**:

- Tauri 的 `NativeFile` 依赖 Tauri IPC，无法直接传入 Worker
- 需要先在主线程将文件读为 `ArrayBuffer`，然后通过 `Transferable` 传入 Worker（零拷贝）
- Worker 内需要独立 import `zip.js`、`franc-min`、`js-md5` 等依赖
- `SharedArrayBuffer` 在 iOS Safari 中需要特定的 COOP/COEP headers，可能不适用

---

### 方案 B：流式/分块文本处理

**目标**: 不再一次性读入全部内容，改为分块扫描，将内存峰值从 ~300MB 降到 ~5-10MB。

**核心思路**: 章节检测本质上是「逐行扫描找标题行」，不需要把整个文件放在一个字符串里。

**Phase 1: 分块扫描章节边界**

```typescript
interface ChapterBoundary {
  byteOffset: number;
  title: string;
}

async function scanChapterBoundaries(file: File, encoding: string): Promise<ChapterBoundary[]> {
  const CHUNK_SIZE = 512 * 1024; // 512KB per chunk
  const decoder = new TextDecoder(encoding, { fatal: false });
  const boundaries: ChapterBoundary[] = [];
  let offset = 0;
  let lineBuffer = '';
  let byteOffset = 0;

  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunk = await file.slice(offset, end).arrayBuffer();
    const text = decoder.decode(chunk, { stream: offset + CHUNK_SIZE < file.size });
    const combined = lineBuffer + text;
    const lines = combined.split('\n');
    lineBuffer = lines.pop()!; // 保留不完整的最后一行

    for (const line of lines) {
      if (isChapterTitle(line)) {
        boundaries.push({ byteOffset, title: line.trim() });
      }
      byteOffset += new TextEncoder().encode(line + '\n').length;
    }
    offset += CHUNK_SIZE;
  }
  return boundaries;
}
```

**Phase 2: 逐章读取 + 流式写入 ZIP**

```typescript
for (const [i, boundary] of boundaries.entries()) {
  const nextOffset = boundaries[i + 1]?.byteOffset ?? file.size;
  const chapterBlob = file.slice(boundary.byteOffset, nextOffset);
  const chapterText = await chapterBlob.text();
  const xhtml = formatChapterXHTML(chapterText, boundary.title);
  await zipWriter.add(`OEBPS/chapter${i + 1}.xhtml`, new TextReader(xhtml));
  // 每章写完后，chapterText 可被 GC 回收
}
```

**内存对比**:

| 指标               | 当前实现             | 分块实现                         |
| ------------------ | -------------------- | -------------------------------- |
| 峰值内存           | ~300MB               | ~5-10MB                          |
| 同时在内存中的文本 | 全部 30MB + 多份拷贝 | 仅 1 个 chunk (512KB) + 当前章节 |
| 30MB 文件可行性    | iOS 上卡死/崩溃      | 流畅                             |
| 100MB 文件可行性   | 任何平台都不行       | 依然可行                         |

---

### 方案 C：编码检测采样化（快速修复）

**目标**: 编码检测从处理 30MB 降到处理 ~72KB。

**修改文件**: `apps/readest-app/src/utils/txt.ts`，`detectEncoding` 方法

**现在的代码** (line 416-418):

```typescript
try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer); // 30MB 全量解码
    return 'utf-8';
}
```

**修改为**:

```typescript
private detectEncoding(buffer: ArrayBuffer): string | undefined {
    const sampleSize = Math.min(buffer.byteLength, 64 * 1024); // 最多 64KB
    const headSample = buffer.slice(0, sampleSize);

    try {
        new TextDecoder('utf-8', { fatal: true }).decode(headSample);
        // 额外验证中间部分，防止文件头是 UTF-8 但中间不是
        if (buffer.byteLength > sampleSize * 2) {
            const midStart = Math.floor(buffer.byteLength / 2);
            const midSample = buffer.slice(midStart, midStart + 8192);
            new TextDecoder('utf-8', { fatal: true }).decode(midSample);
        }
        return 'utf-8';
    } catch {
        // ... 后续 fallback 逻辑不变（已经是基于采样的）
    }
    // ... 其余逻辑不变
}
```

**收益**: 编码检测从处理 30MB 降到处理约 72KB，几乎瞬间完成。

---

### 方案 D：章节提取单次化

**目标**: 避免最多 3 轮完整的 `extractChapters` 调用。

**修改文件**: `apps/readest-app/src/utils/txt.ts`，`convert` 方法 (line 81-92)

**现在的代码**:

```typescript
for (let i = 8; i >= 6; i--) {
  chapters = this.extractChapters(txtContent, metadata, {
    linesBetweenSegments: i,
    fallbackParagraphsPerChapter: 100,
  });
  if (chapters.length === 0) {
    throw new Error('No chapters detected.');
  } else if (chapters.length > 1) {
    break;
  }
}
```

**优化思路**:

1. 先用低成本的方式统计空行分布（一次遍历），确定最佳的 `linesBetweenSegments`
2. 然后只做一次 `extractChapters`
3. 或者在 `extractChapters` 内部，先用 `indexOf('\n\n\n')` 等简单方法找到分割点，避免在全文上做正则 split

```typescript
// 先统计空行分布，O(n) 单次遍历
private findBestSegmentThreshold(text: string): number {
    let maxConsecutiveNewlines = 0;
    let current = 0;
    for (const ch of text) {
        if (ch === '\n') { current++; maxConsecutiveNewlines = Math.max(maxConsecutiveNewlines, current); }
        else { current = 0; }
    }
    // 从最严格开始，找到能产生多个 segment 的阈值
    for (let threshold = Math.min(8, maxConsecutiveNewlines); threshold >= 6; threshold--) {
        // 简单计数，不做 split
        const regex = new RegExp(`(?:\\r?\\n){${threshold},}`, 'g');
        const count = (text.match(regex) || []).length;
        if (count > 0) return threshold;
    }
    return 6;
}
```

---

### 方案 E：语言检测去重（一行修复）

**目标**: 消除每章重复的 `franc` 语言检测调用。

**修改文件**: `apps/readest-app/src/utils/txt.ts`，`createEpub` 方法 (line 371)

**现在的代码**:

```typescript
for (let i = 0; i < chapters.length; i++) {
  const lang = detectLanguage(chapter.text); // franc 库，每章调用一次
  // ...
}
```

**修改为**:

```typescript
for (let i = 0; i < chapters.length; i++) {
  const lang = metadata.language; // 已在 convert() line 75 检测过一次
  // ...
}
```

**说明**: `metadata.language` 已经在 `convert()` 方法中通过 `detectLanguage(fileHeader)` (line 75) 设置过了。对一本书来说，所有章节共用同一个语言是合理的。

---

### 方案 F：原生 TXT 渲染器（长期方案）

**目标**: 完全跳过 TXT → EPUB 转换，直接实现 foliate-js 的 book interface，按需加载章节。

**核心思路**: foliate-js 的 book interface 只要求 `sections` 数组，每个 section 有 `load()` 方法返回可渲染的内容。TXT 文件完全可以直接适配这个接口，不需要先转成 EPUB。

**foliate-js book interface 要求**:

```typescript
interface BookDoc {
  metadata: BookMetadata;
  sections: Array<{
    load(): Promise<string>; // 返回可渲染的 URL
    createDocument(): Promise<Document>; // 用于搜索
    size: number;
    linear: string;
    cfi: string;
    id: string;
  }>;
  toc: Array<{ label: string; href: string; subitems?: TOCItem[] }>;
  dir: string;
  splitTOCHref(href: string): Array<string | number>;
  getCover(): Promise<Blob | null>;
}
```

**实现草案**:

```typescript
class TxtBook implements BookDoc {
  private file: File;
  private chapterBoundaries: Array<{ start: number; end: number; title: string }>;
  private encoding: string;

  async init(): Promise<this> {
    this.encoding = detectEncodingSampled(this.file);

    // Phase 1: 流式扫描，只记录章节边界（字节偏移）— 内存开销极小
    this.chapterBoundaries = await this.scanChapterBoundaries();

    // sections 是 lazy 的 — 只有渲染到某章时才读取对应片段
    this.sections = this.chapterBoundaries.map((ch, i) => ({
      id: `ch-${i}`,
      size: ch.end - ch.start,
      linear: 'yes',
      cfi: `/6/${(i + 1) * 2}`,
      load: async () => {
        const blob = this.file.slice(ch.start, ch.end);
        const text = await new Response(blob).text();
        const html = this.wrapAsHTML(text, ch.title);
        return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      },
      unload: () => {
        /* revoke blob URL */
      },
      createDocument: async () => {
        const blob = this.file.slice(ch.start, ch.end);
        const text = await new Response(blob).text();
        return new DOMParser().parseFromString(this.wrapAsHTML(text, ch.title), 'text/html');
      },
    }));

    return this;
  }
}
```

**修改涉及的文件**:

- 新建 `apps/readest-app/src/libs/txt-book.ts` — TXT book adapter
- 修改 `apps/readest-app/src/libs/document.ts` — `DocumentLoader.open()` 添加 TXT 分支
- 修改 `apps/readest-app/src/services/appService.ts` — `importBook()` 中 TXT 不再走 EPUB 转换

**优势**:
| 指标 | 当前(EPUB转换) | 原生渲染器 |
|---|---|---|
| 打开 30MB TXT | 卡死/崩溃 | < 1秒 |
| 内存峰值 | ~300MB | ~2-5MB（仅当前章节） |
| 支持 100MB+ TXT | 不可能 | 可行 |
| 打开速度 | 数十秒 | 亚秒级 |

**劣势**:

- 实现工作量较大（需要完整实现 book interface）
- 书签、标注等功能需要 CFI 支持的适配
- 保存为 EPUB 的功能需要另外处理（如果需要的话）
- 需要在 `importBook` 中区分 TXT 的存储方式（存原始 TXT，而非转换后的 EPUB）

---

## 6. 推荐实施路径

```
阶段 1 — 快速修复 (1-2 天)
  ├── C. 编码检测采样化      改几行代码，立即见效
  ├── E. 语言检测去重        改一行代码
  └── D. 章节提取减少重复    低风险优化
  │
  └── 预期效果: 30MB TXT 从 "卡死" → "慢但能完成" (iOS), "明显加速" (桌面)

阶段 2 — 核心修复 (3-5 天)
  ├── A. Web Worker 卸载     彻底解决 UI 卡死
  └── B. 分块文本处理        彻底解决内存爆炸
  │
  └── 预期效果: 30MB TXT 流畅导入，UI 可响应，显示进度

阶段 3 — 长期优化 (1-2 周)
  └── F. 原生 TXT 渲染器     根本性解决，最优体验
  │
  └── 预期效果: 任意大小 TXT 秒开，极低内存占用
```

---

## 7. 相关文件索引

| 文件路径                                                     | 作用                         | 瓶颈相关          |
| ------------------------------------------------------------ | ---------------------------- | ----------------- |
| `apps/readest-app/src/utils/txt.ts`                          | TXT → EPUB 转换器            | 🔴 主要瓶颈       |
| `apps/readest-app/src/utils/zip.ts`                          | zip.js 配置                  | 🟠 禁用 WebWorker |
| `apps/readest-app/src/utils/file.ts`                         | NativeFile / RemoteFile 实现 | 文件读取方式      |
| `apps/readest-app/src/utils/md5.ts`                          | partialMD5 哈希              | ✅ 无问题         |
| `apps/readest-app/src/utils/lang.ts`                         | detectLanguage 语言检测      | 🟡 每章重复调用   |
| `apps/readest-app/src/services/appService.ts`                | importBook 入口              | 调度逻辑          |
| `apps/readest-app/src/services/nativeAppService.ts`          | iOS 文件访问                 | 平台适配层        |
| `apps/readest-app/src/libs/document.ts`                      | DocumentLoader               | EPUB 解析入口     |
| `src-tauri/plugins/.../ios/Sources/NativeBridgePlugin.swift` | iOS native bridge            | 文件拷贝          |
