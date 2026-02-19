# Inkline 架构分析文档

> **创建日期**: 2025-02-17
> **目的**: 记录 Inkline 阅读器的核心架构，便于后续开发和维护

---

## 目录

1. [项目概述](#1-项目概述)
2. [书籍阅读功能实现](#2-书籍阅读功能实现)
3. [TTS 听书功能实现](#3-tts-听书功能实现)
4. [关键文件索引](#4-关键文件索引)

---

## 1. 项目概述

### 1.1 技术栈

- **前端框架**: Next.js 16 + React 18
- **桌面/移动端**: Tauri v2 (Rust 后端)
- **核心渲染引擎**: foliate-js
- **支持平台**: macOS, Windows, Linux, Android, iOS, Web

### 1.2 核心依赖库

| 库         | 用途                     |
| ---------- | ------------------------ |
| foliate-js | 电子书解析与渲染核心引擎 |
| zip.js     | EPUB/CBZ 压缩包处理      |
| fflate     | MOBI 解压缩              |
| PDF.js     | PDF 渲染 (实验性)        |
| edge-tts   | 微软云端 TTS 服务        |

### 1.3 支持的书籍格式

| 格式      | 处理模块                   | 特点                       |
| --------- | -------------------------- | -------------------------- |
| EPUB      | `foliate-js/epub.js`       | 随机访问 ZIP，按需加载章节 |
| PDF       | `foliate-js/pdf.js`        | 实验性，基于 PDF.js        |
| MOBI/AZW3 | `foliate-js/mobi.js`       | 增量解压                   |
| CBZ       | `foliate-js/comic-book.js` | 漫画图片按需加载           |
| FB2/FBZ   | `foliate-js/fb2.js`        | FictionBook 格式           |
| TXT       | `TxtToEpubConverter`       | 先转换为 EPUB 再渲染       |

---

## 2. 书籍阅读功能实现

### 2.1 架构层次

```
┌─────────────────────────────────────────────────────────────┐
│                      Reader.tsx                              │
│              (全局容器：主题、屏幕常亮、Toast)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   ReaderContent.tsx                          │
│           (多书籍管理：初始化 ViewState、Parallel Read)        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                     BooksGrid.tsx                            │
│        (布局管理：单书/多书网格、Header/Footer/Annotator)       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  FoliateViewer.tsx                           │
│      核心渲染器：包装 foliate-view Web Component               │
│      • 内容转换 (transformers)                                │
│      • 样式注入 (style.ts)                                    │
│      • 事件监听 (iframe events)                               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 文档加载流程

```
用户选择文件
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  DocumentLoader.open()  (libs/document.ts)                   │
│  • 检测文件类型 (魔数: ZIP=PK, PDF=%PDF)                       │
│  • 创建对应的 foliate-js 解析器                                │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   isZip()            isPDF()            isMOBI()
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ EPUB / CBZ    │  │ PDF           │  │ MOBI / AZW3   │
│ makeZipLoader │  │ makePDF       │  │ MOBI.open     │
│ (按需解压)     │  │ (PDF.js)      │  │ (fflate解压)  │
└───────────────┘  └───────────────┘  └───────────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                    BookDoc 对象
                (metadata, toc, sections)
                           │
                           ▼
                 FoliateViewer.open(bookDoc)
```

### 2.3 核心渲染引擎：foliate-js

foliate-js 是一个纯 JavaScript 的电子书渲染库，设计目标是**轻量、高性能、不依赖加载整个文件到内存**。

#### 分页算法

使用 **CSS 多列布局** + **二分查找算法** 精确定位当前可见的 DOM Range：

```javascript
// paginator.js 核心算法
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
  if (end - start === 1) {
    const result = cb(makeRange(doc, node, start), makeRange(doc, node, end));
    return result < 0 ? start : end;
  }
  const mid = Math.floor(start + (end - start) / 2);
  const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end));
  // ... continues binary search for visible offset
};
```

#### FoliateViewer 初始化

```typescript
// FoliateViewer.tsx:305-328
await import('foliate-js/view.js');
const view = wrappedFoliateView(document.createElement('foliate-view'));
await view.open(bookDoc);
view.renderer.setStyles?.(getStyles(viewSettings));
```

### 2.4 内容转换管道

在内容渲染前，Inkline 应用一系列转换器处理内容：

```typescript
// FoliateViewer.tsx:154-165
transformers: [
  'style', // 样式注入
  'punctuation', // 标点符号规范化
  'footnote', // 脚注提取
  'whitespace', // 空白字符清理
  'language', // 语言检测
  'sanitizer', // 内容清理
  'simplecc', // 中文简繁转换
  'proofread', // 校对规则
];
```

### 2.5 样式系统

**动态 CSS 生成** (`utils/style.ts`):

```typescript
// 根据用户设置动态生成 CSS 字符串
const getStyles = (viewSettings: ViewSettings) => `
  html {
    --serif: ${serifFonts.join(', ')}, serif;
    --sans-serif: ${sansSerifFonts.join(', ')}, sans-serif;
    --font-size: ${fontSize}px;
  }
  body {
    line-height: ${lineHeight};
    text-align: ${textAlign};
  }
`;
```

**主题模式**：通过 CSS Part 实现 Dark Mode，避免修改内容颜色：

```css
foliate-view::part(filter) {
  filter: invert(1) hue-rotate(180deg);
}
```

### 2.6 导航控制

**分页模式** (`usePagination.ts`):

| 模式        | 描述                      |
| ----------- | ------------------------- |
| `paginated` | 翻页模式，左右/上下切换   |
| `scrolled`  | 滚动模式，连续阅读        |
| `pan`       | 平移模式 (固定布局缩放时) |

**翻页触发方式**:

- 点击屏幕分区 (左/中/右)
- 键盘/音量键
- 滚轮/触摸滑动

### 2.7 性能优化策略

| 策略            | 实现                                     |
| --------------- | ---------------------------------------- |
| **按需加载**    | ZIP 格式只读取当前章节，不解压整个文件   |
| **延迟图片**    | 图片仅在章节加载时才请求                 |
| **CSS 多列**    | 浏览器原生分页，无需 JS 计算             |
| **二分定位**    | 快速找到当前可见位置                     |
| **iframe 隔离** | 内容在独立 iframe 中渲染，避免影响主界面 |

---

## 3. TTS 听书功能实现

### 3.1 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        useTTSControl Hook                            │
│              (UI 控制层：播放/暂停、语速、声音选择)                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                       TTSController                                  │
│              (核心控制器：状态管理、SSML 处理、章节导航)                  │
└───────┬─────────────────────────────────────────────┬───────────────┘
        │                                             │
        │ 管理多个 TTS 客户端                            │
        ▼                                             ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│   WebSpeechClient │  │   EdgeTTSClient   │  │  NativeTTSClient  │
│  (浏览器原生 TTS)   │  │  (微软云端 TTS)    │  │  (Android 系统TTS) │
│                   │  │                   │  │                   │
│  SpeechSynthesis  │  │  WebSocket/HTTP   │  │  Rust Tauri 插件  │
│  API              │  │  微软语音服务       │  │                   │
└───────────────────┘  └───────────────────┘  └───────────────────┘
        │                       │                      │
        └───────────────────────┼──────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │   foliate-js/tts.js   │
                    │   (文本遍历与分句)       │
                    └───────────────────────┘
```

### 3.2 三种 TTS 引擎对比

| 特性         | Web Speech API | Edge TTS           | Native TTS  |
| ------------ | -------------- | ------------------ | ----------- |
| **平台**     | 所有浏览器     | 所有平台           | Android/iOS |
| **网络**     | 不需要         | 需要网络           | 不需要      |
| **语音质量** | 系统依赖       | 高质量神经网络语音 | 系统依赖    |
| **延迟**     | 低             | 较高 (云端合成)    | 低          |
| **语音数量** | 系统语音       | 100+ 种语言        | 系统语音    |
| **优先级**   | 最低           | 最高               | 中等        |

### 3.3 核心流程

#### 3.3.1 文本提取 (foliate-js/tts.js)

```typescript
// TTSController.ts:164-181
const { TTS } = await import('foliate-js/tts.js');
const { textWalker } = await import('foliate-js/text-walker.js');

// CJK 语言按句子分割，其他语言按单词分割
let granularity: TTSGranularity = this.view.language.isCJK ? 'sentence' : 'word';

this.view.tts = new TTS(
  doc,
  textWalker, // 文本遍历器
  createRejectFilter({
    // 过滤掉注音、脚注标记等
    tags: ['rt'],
    contents: [{ tag: 'a', content: /^[\[\(]?[\*\d]+[\)\]]?$/ }],
  }),
  this.#getHighlighter(), // 高亮回调
  granularity,
);
```

#### 3.3.2 SSML 生成与处理

**SSML 格式** (Speech Synthesis Markup Language):

```xml
<speak version="1.0" xml:lang="en">
  <voice name="en-US-AriaNeural">
    <prosody rate="1.3">
      <mark name="0"/>The quick brown fox...
      <mark name="1"/>jumps over the lazy dog.
    </prosody>
  </voice>
</speak>
```

**预处理步骤** (`TTSController.ts:248-268`):

```typescript
ssml = ssml
  .replace(/<emphasis[^>]*>([^<]+)<\/emphasis>/g, '$1') // 移除强调标签
  .replace(/[–—]/g, ',') // 破折号转逗号
  .replace(/\.{3,}/g, '   ') // 省略号处理
  .replace(/……/g, '  ') // 中文省略号
  .replace(/\*/g, ' '); // 移除星号
```

#### 3.3.3 语音合成

**Web Speech API 方式** (`WebSpeechClient.ts`):

```typescript
const synth = window.speechSynthesis;
const utterance = new SpeechSynthesisUtterance();
utterance.text = mark.text;
utterance.rate = this.#rate;
utterance.voice = await this.getVoice(lang);
synth.speak(utterance);
```

**Edge TTS 方式** (`EdgeTTSClient.ts`):

```typescript
// 通过 WebSocket 连接微软语音服务
const audioUrl = await this.#edgeTTS?.createAudioUrl({
  lang: 'en-US',
  text: 'Hello world',
  voice: 'en-US-AriaNeural',
  rate: 1.3,
});

// 播放生成的音频
const audio = new Audio(audioUrl);
await audio.play();
```

### 3.4 高级特性

#### 3.4.1 预加载优化

```typescript
// TTSController.ts:230-246
async preloadNextSSML(count: number = 4) {
  const ssmls: string[] = [];
  for (let i = 0; i < count; i++) {
    const ssml = await this.#preprocessSSML(tts.next());
    if (!ssml) break;
    ssmls.push(ssml);
  }
  // 预加载下 4 段文本的音频
  await Promise.all(ssmls.map((ssml) => this.preloadSSML(ssml, signal)));
}
```

#### 3.4.2 文本高亮同步

```typescript
// TTSController.ts:99-117
#getHighlighter() {
  return (range: Range) => {
    const { doc, overlayer } = this.view.renderer.getContents()[0];
    const cfi = this.view.getCFI(index, range);
    const visibleRange = this.view.resolveCFI(cfi).anchor(doc);
    const { style, color } = this.options;
    overlayer?.remove(HIGHLIGHT_KEY);
    overlayer?.add(HIGHLIGHT_KEY, visibleRange, Overlayer[style], { color });
  };
}
```

#### 3.4.3 多语言混合朗读

当书籍包含多语言内容时，TTS 会自动检测每段文本的语言并选择合适的语音：

```typescript
// ssml.ts:100-110
// 支持 <lang xml:lang="zh-CN">中文内容</lang> 标签
if (tagName === 'lang') {
  if (!isEnd) {
    langStack.push(currentLang);
    currentLang = langMatch[1]; // 切换到新语言
  } else {
    currentLang = langStack.pop(); // 恢复原语言
  }
}
```

#### 3.4.4 与翻译功能集成

TTS 可以朗读原文或译文：

```typescript
// useTTSControl.ts:233-238
const getTTSTargetLang = (): string | null => {
  if (vs?.translationEnabled && ttsReadAloudText === 'translated') {
    return vs.translationLang; // 朗读译文
  } else if (vs?.translationEnabled && ttsReadAloudText === 'source') {
    return bookLang; // 朗读原文
  }
};
```

### 3.5 状态管理

```typescript
type TTSState =
  | 'stopped' // 已停止
  | 'playing' // 播放中
  | 'paused' // 已暂停
  | 'stop-paused' // 停止后暂停
  | 'backward-paused' // 后退后暂停
  | 'forward-paused' // 前进后暂停
  | 'setrate-paused' // 调速后暂停
  | 'setvoice-paused'; // 换声后暂停
```

### 3.6 TTS 数据流总结

```
用户点击播放
    │
    ▼
useTTSControl.handleTTSSpeak()
    │
    ├── 创建 TTSController
    │   │
    │   ├── 初始化 TTS 客户端
    │   │   ├── EdgeTTSClient (云端高质量语音)
    │   │   ├── NativeTTSClient (系统语音)
    │   │   └── WebSpeechClient (浏览器语音)
    │   │
    │   └── 初始化 foliate-js TTS (文本遍历)
    │
    ├── 从当前位置获取 SSML
    │   └── view.tts.from(range) → SSML with <mark> tags
    │
    ├── 预处理 SSML
    │   └── 清理标点、过滤语言、校对规则
    │
    ├── 预加载音频
    │   └── 预加载接下来 4 段的音频
    │
    └── 播放
        └── ttsClient.speak(ssml)
            ├── 解析 SSML 中的 marks
            ├── 逐段合成语音
            ├── 播放音频
            └── 同步高亮位置
```

---

## 4. 关键文件索引

### 4.1 阅读功能

| 文件                                                           | 功能                           |
| -------------------------------------------------------------- | ------------------------------ |
| `apps/readest-app/src/libs/document.ts`                        | DocumentLoader，格式检测与加载 |
| `apps/readest-app/src/app/reader/components/Reader.tsx`        | 顶层容器组件                   |
| `apps/readest-app/src/app/reader/components/ReaderContent.tsx` | 多书籍管理                     |
| `apps/readest-app/src/app/reader/components/BooksGrid.tsx`     | 书籍网格布局                   |
| `apps/readest-app/src/app/reader/components/FoliateViewer.tsx` | 核心渲染组件                   |
| `apps/readest-app/src/utils/style.ts`                          | 动态样式生成                   |
| `apps/readest-app/src/app/reader/hooks/usePagination.ts`       | 翻页导航逻辑                   |
| `apps/readest-app/src/store/readerStore.ts`                    | 阅读器状态管理                 |
| `apps/readest-app/src/services/transformService.ts`            | 内容转换管道                   |

### 4.2 TTS 功能

| 文件                                                     | 功能                         |
| -------------------------------------------------------- | ---------------------------- |
| `apps/readest-app/src/services/tts/TTSController.ts`     | 核心控制器，管理状态和客户端 |
| `apps/readest-app/src/services/tts/TTSClient.ts`         | 客户端接口定义               |
| `apps/readest-app/src/services/tts/WebSpeechClient.ts`   | Web Speech API 实现          |
| `apps/readest-app/src/services/tts/EdgeTTSClient.ts`     | Edge TTS 云端实现            |
| `apps/readest-app/src/services/tts/NativeTTSClient.ts`   | Android/iOS 原生 TTS         |
| `apps/readest-app/src/services/tts/types.ts`             | TTS 类型定义                 |
| `apps/readest-app/src/utils/ssml.ts`                     | SSML 解析和生成              |
| `apps/readest-app/src/libs/edgeTTS.ts`                   | Edge TTS API 封装            |
| `apps/readest-app/src/app/reader/hooks/useTTSControl.ts` | React Hook，UI 控制          |

### 4.3 格式处理

| 文件                                 | 功能               |
| ------------------------------------ | ------------------ |
| `apps/readest-app/src/utils/txt.ts`  | TXT 转 EPUB 转换器 |
| `apps/readest-app/src/utils/file.ts` | 文件访问抽象层     |
| `apps/readest-app/src/utils/zip.ts`  | zip.js 配置        |

---

## 更新日志

| 日期       | 内容                                     |
| ---------- | ---------------------------------------- |
| 2025-02-17 | 初始创建：阅读功能架构、TTS 功能架构分析 |
