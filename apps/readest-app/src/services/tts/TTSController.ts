import { FoliateView } from '@/types/view';
import { AppService } from '@/types/system';
import { filterSSMLWithLang, parseSSMLMarks } from '@/utils/ssml';
import { Overlayer } from 'foliate-js/overlayer.js';
import { TTSGranularity, TTSHighlightOptions, TTSMark, TTSVoice } from './types';
import { createRejectFilter } from '@/utils/node';
import { WebSpeechClient } from './WebSpeechClient';
import { NativeTTSClient } from './NativeTTSClient';
import { EdgeTTSClient } from './EdgeTTSClient';
import { TTSUtils } from './TTSUtils';
import { TTSClient } from './TTSClient';
import { RemoteTTSClient } from './RemoteTTSClient';
import { TTSSettings } from '@/types/settings';
import {
  DEFAULT_REMOTE_CHUNK_HARD_LIMIT_CHARS,
  DEFAULT_REMOTE_CHUNK_MAX_SENTENCES,
  DEFAULT_REMOTE_CHUNK_TARGET_CHARS,
  DEFAULT_REMOTE_QUEUE_TARGET_SIZE,
} from './providerSettings';

type TTSState =
  | 'stopped'
  | 'playing'
  | 'paused'
  | 'stop-paused'
  | 'backward-paused'
  | 'forward-paused'
  | 'setrate-paused'
  | 'setvoice-paused';

const HIGHLIGHT_KEY = 'tts-highlight';

export class TTSController extends EventTarget {
  appService: AppService | null = null;
  view: FoliateView;
  isAuthenticated: boolean = false;
  preprocessCallback?: (ssml: string) => Promise<string>;
  onSectionChange?: (sectionIndex: number) => Promise<void>;
  #nossmlCnt: number = 0;
  #currentSpeakAbortController: AbortController | null = null;
  #currentSpeakPromise: Promise<void> | null = null;
  #isPreloading: boolean = false;
  #ttsSectionIndex: number = -1;

  state: TTSState = 'stopped';
  ttsLang: string = '';
  ttsRate: number = 1.0;
  ttsClient: TTSClient;
  ttsWebClient: TTSClient;
  ttsEdgeClient: TTSClient;
  ttsNativeClient: TTSClient | null = null;
  ttsRemoteClient: TTSClient;
  ttsWebVoices: TTSVoice[] = [];
  ttsEdgeVoices: TTSVoice[] = [];
  ttsNativeVoices: TTSVoice[] = [];
  ttsRemoteVoices: TTSVoice[] = [];
  ttsTargetLang: string = '';
  ttsSettings: TTSSettings | null = null;
  #remoteBatchPreferredChars = DEFAULT_REMOTE_CHUNK_TARGET_CHARS;
  #remoteBatchAbsoluteChars = DEFAULT_REMOTE_CHUNK_HARD_LIMIT_CHARS;
  #remoteBatchMaxSentences = DEFAULT_REMOTE_CHUNK_MAX_SENTENCES;
  #remoteBatchQueueTargetSize = DEFAULT_REMOTE_QUEUE_TARGET_SIZE;
  #remoteBatchQueue: string[] = [];

  options: TTSHighlightOptions = { style: 'highlight', color: 'gray' };

  constructor(
    appService: AppService | null,
    view: FoliateView,
    isAuthenticated: boolean = false,
    preprocessCallback?: (ssml: string) => Promise<string>,
    onSectionChange?: (sectionIndex: number) => Promise<void>,
    ttsSettings?: TTSSettings | null,
  ) {
    super();
    this.ttsWebClient = new WebSpeechClient(this);
    this.ttsEdgeClient = new EdgeTTSClient(this, appService);
    // TODO: implement native TTS client for iOS and PC
    if (appService?.isAndroidApp) {
      this.ttsNativeClient = new NativeTTSClient(this);
    }
    this.ttsRemoteClient = new RemoteTTSClient(this, () => this.ttsSettings);
    this.ttsClient = this.ttsWebClient;
    this.appService = appService;
    this.view = view;
    this.isAuthenticated = isAuthenticated;
    this.preprocessCallback = preprocessCallback;
    this.onSectionChange = onSectionChange;
    this.ttsSettings = ttsSettings || null;
  }

  async init() {
    const availableClients = [];
    if (await this.ttsEdgeClient.init()) {
      availableClients.push(this.ttsEdgeClient);
    }
    if (this.ttsNativeClient && (await this.ttsNativeClient.init())) {
      availableClients.push(this.ttsNativeClient);
      this.ttsNativeVoices = await this.ttsNativeClient.getAllVoices();
    }
    if (await this.ttsRemoteClient.init()) {
      availableClients.push(this.ttsRemoteClient);
    }
    if (await this.ttsWebClient.init()) {
      availableClients.push(this.ttsWebClient);
    }
    this.ttsClient = availableClients[0] || this.ttsWebClient;
    const preferredClientName = this.ttsSettings?.defaultEngine || TTSUtils.getPreferredClient();
    if (preferredClientName) {
      await this.setEngine(preferredClientName, false, availableClients);
    }
    this.ttsWebVoices = await this.ttsWebClient.getAllVoices();
    this.ttsEdgeVoices = await this.ttsEdgeClient.getAllVoices();
    this.ttsRemoteVoices = await this.ttsRemoteClient.getAllVoices();
  }

  async setEngine(
    engine: string,
    persist = true,
    availableClients?: TTSClient[],
  ): Promise<boolean> {
    const candidates = availableClients || [
      this.ttsEdgeClient,
      ...(this.ttsNativeClient ? [this.ttsNativeClient] : []),
      this.ttsRemoteClient,
      this.ttsWebClient,
    ];
    const selected = candidates.find((client) => client.name === engine && client.initialized);
    if (!selected) return false;
    this.ttsClient = selected;
    await this.ttsClient.setRate(this.ttsRate);
    if (persist) {
      TTSUtils.setPreferredClient(this.ttsClient.name);
      if (this.ttsSettings) {
        this.ttsSettings.defaultEngine = this.ttsClient.name as TTSSettings['defaultEngine'];
      }
    }
    return true;
  }

  getEngine(): string {
    return this.ttsClient.name;
  }

  #getHighlighter() {
    return (range: Range) => {
      const { doc, index, overlayer } = this.view.renderer.getContents()[0] as {
        doc: Document;
        index?: number;
        overlayer?: Overlayer;
      };
      if (!doc || index === undefined || index !== this.#ttsSectionIndex) {
        return;
      }
      try {
        const cfi = this.view.getCFI(index, range);
        const visibleRange = this.view.resolveCFI(cfi).anchor(doc);
        const { style, color } = this.options;
        overlayer?.remove(HIGHLIGHT_KEY);
        overlayer?.add(HIGHLIGHT_KEY, visibleRange, Overlayer[style], { color });
      } catch {}
    };
  }

  #clearHighlighter() {
    const { overlayer } = (this.view.renderer.getContents()?.[0] || {}) as { overlayer: Overlayer };
    overlayer?.remove(HIGHLIGHT_KEY);
  }

  async initViewTTS(options?: TTSHighlightOptions) {
    if (options) {
      this.options.style = options.style;
      this.options.color = options.color;
    }
    const currentSectionIndex = this.view.renderer.getContents()[0]?.index ?? 0;
    if (this.#ttsSectionIndex === -1) {
      await this.#initTTSForSection(currentSectionIndex);
    }
  }

  async #initTTSForSection(sectionIndex: number): Promise<boolean> {
    const sections = this.view.book.sections;
    if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) {
      return false;
    }

    const section = sections[sectionIndex];
    if (!section?.createDocument) {
      return false;
    }

    this.#ttsSectionIndex = sectionIndex;
    this.#remoteBatchQueue = [];

    const currentSection = this.view.renderer.getContents()[0];
    if (currentSection?.index !== sectionIndex) {
      await this.onSectionChange?.(sectionIndex);
    }

    let doc: Document;
    if (currentSection?.index === sectionIndex && currentSection?.doc) {
      doc = currentSection.doc;
    } else {
      doc = await section.createDocument();
    }

    if (this.view.tts && this.view.tts.doc === doc) {
      return true;
    }

    const { TTS } = await import('foliate-js/tts.js');
    const { textWalker } = await import('foliate-js/text-walker.js');
    let granularity: TTSGranularity = this.view.language.isCJK ? 'sentence' : 'word';
    const supportedGranularities = this.ttsClient.getGranularities();
    if (!supportedGranularities.includes(granularity)) {
      granularity = supportedGranularities[0]!;
    }

    this.view.tts = new TTS(
      doc,
      textWalker,
      createRejectFilter({
        tags: ['rt'],
        contents: [{ tag: 'a', content: /^[\[\(]?[\*\d]+[\)\]]?$/ }],
      }),
      this.#getHighlighter(),
      granularity,
    );
    console.log(`Initialized TTS for section ${sectionIndex}`);

    return true;
  }

  async #initTTSForNextSection(): Promise<boolean> {
    const nextIndex = this.#ttsSectionIndex + 1;
    const sections = this.view.book.sections;

    if (!sections || nextIndex >= sections.length) {
      return false;
    }

    return await this.#initTTSForSection(nextIndex);
  }

  async #initTTSForPrevSection(): Promise<boolean> {
    const prevIndex = this.#ttsSectionIndex - 1;

    if (prevIndex < 0) {
      return false;
    }

    return await this.#initTTSForSection(prevIndex);
  }

  async #handleNavigationWithSSML(ssml: string | undefined, isPlaying: boolean) {
    if (isPlaying) this.#speak(ssml);
  }

  async #handleNavigationWithoutSSML(initSection: () => Promise<boolean>, isPlaying: boolean) {
    if (await initSection()) {
      if (isPlaying) {
        this.#speak(this.view.tts?.start());
      } else {
        this.view.tts?.start();
      }
    } else {
      await this.stop();
    }
  }

  async preloadSSML(ssml: string | undefined, signal: AbortSignal) {
    if (!ssml) return;
    const iter = await this.ttsClient.speak(ssml, signal, true);
    for await (const _ of iter);
  }

  async preloadNextSSML(count: number = 4) {
    if (this.ttsClient.name === 'remote-tts') return;
    const tts = this.view.tts;
    if (!tts) return;

    this.#isPreloading = true;
    const ssmls: string[] = [];
    for (let i = 0; i < count; i++) {
      const ssml = await this.#preprocessSSML(tts.next());
      if (!ssml) break;
      ssmls.push(ssml);
    }
    for (let i = 0; i < ssmls.length; i++) {
      tts.prev();
    }
    this.#isPreloading = false;
    await Promise.all(ssmls.map((ssml) => this.preloadSSML(ssml, new AbortController().signal)));
  }

  async #preprocessSSML(ssml?: string) {
    if (!ssml) return;
    ssml = ssml
      .replace(/<emphasis[^>]*>([^<]+)<\/emphasis>/g, '$1')
      .replace(/[–—]/g, ',')
      .replace('<break/>', ' ')
      .replace(/\.{3,}/g, '   ')
      .replace(/……/g, '  ')
      .replace(/\*/g, ' ')
      .replace(/·/g, ' ');

    if (this.ttsTargetLang) {
      ssml = filterSSMLWithLang(ssml, this.ttsTargetLang);
    }

    if (this.preprocessCallback) {
      ssml = await this.preprocessCallback(ssml);
    }

    return ssml;
  }

  #extractSpeakBody(ssml: string): { openTag: string; body: string } | null {
    const openTagMatch = ssml.match(/<speak\b[^>]*>/i);
    const closeTagMatch = ssml.match(/<\/speak>/i);
    if (!openTagMatch || !closeTagMatch) return null;
    const openTag = openTagMatch[0];
    const body = ssml
      .replace(/^[\s\S]*?<speak\b[^>]*>/i, '')
      .replace(/<\/speak>[\s\S]*$/i, '')
      .trim();
    return { openTag, body };
  }

  #mergeSSMLBatch(ssmlBatch: string[]): string {
    if (ssmlBatch.length <= 1) return ssmlBatch[0]!;
    const parsedBatch = ssmlBatch
      .map((item) => this.#extractSpeakBody(item))
      .filter((item): item is { openTag: string; body: string } => !!item && item.body.length > 0);
    if (parsedBatch.length === 0) return ssmlBatch[0]!;
    if (parsedBatch.length === 1)
      return `${parsedBatch[0]!.openTag}${parsedBatch[0]!.body}</speak>`;
    const openTag = parsedBatch[0]!.openTag;
    const mergedBody = parsedBatch.map((item) => item.body).join('');
    return `${openTag}${mergedBody}</speak>`;
  }

  async #buildRemoteBatchSSML(initialSSML: string): Promise<string> {
    if (this.ttsClient.name !== 'remote-tts') return initialSSML;
    const tts = this.view.tts;
    if (!tts) return initialSSML;

    const ssmlBatch = [initialSSML];
    let totalChars = parseSSMLMarks(initialSSML).plainText.length;

    while (
      ssmlBatch.length < this.#remoteBatchMaxSentences &&
      totalChars < this.#remoteBatchPreferredChars
    ) {
      const nextRaw = tts.next();
      if (!nextRaw) break;
      const nextSSML = await this.#preprocessSSML(nextRaw);
      if (!nextSSML) {
        continue;
      }
      const nextChars = parseSSMLMarks(nextSSML).plainText.length;
      if (
        ssmlBatch.length > 0 &&
        totalChars > 0 &&
        totalChars + nextChars > this.#remoteBatchAbsoluteChars
      ) {
        tts.prev();
        break;
      }
      ssmlBatch.push(nextSSML);
      totalChars += nextChars;
    }

    return this.#mergeSSMLBatch(ssmlBatch);
  }

  #applyRemoteTuningFromSettings() {
    const activeProviderId = this.ttsSettings?.activeProviderId;
    const activeProvider = activeProviderId
      ? this.ttsSettings?.providers.find((provider) => provider.id === activeProviderId)
      : null;
    const maxSentences =
      activeProvider?.remoteChunkMaxSentences || DEFAULT_REMOTE_CHUNK_MAX_SENTENCES;
    const targetChars = activeProvider?.remoteChunkTargetChars || DEFAULT_REMOTE_CHUNK_TARGET_CHARS;
    const hardLimitChars =
      activeProvider?.remoteChunkHardLimitChars || DEFAULT_REMOTE_CHUNK_HARD_LIMIT_CHARS;
    const queueSize = activeProvider?.remoteQueueTargetSize || DEFAULT_REMOTE_QUEUE_TARGET_SIZE;

    this.#remoteBatchMaxSentences = Math.max(1, Math.min(8, Math.round(maxSentences)));
    this.#remoteBatchAbsoluteChars = Math.max(60, Math.min(600, Math.round(hardLimitChars)));
    this.#remoteBatchPreferredChars = Math.max(
      40,
      Math.min(this.#remoteBatchAbsoluteChars, Math.round(targetChars)),
    );
    this.#remoteBatchQueueTargetSize = Math.max(1, Math.min(8, Math.round(queueSize)));
  }

  async #fillRemoteBatchQueue() {
    if (this.ttsClient.name !== 'remote-tts') return;
    const tts = this.view.tts;
    if (!tts) return;

    while (this.#remoteBatchQueue.length < this.#remoteBatchQueueTargetSize) {
      const nextRaw = tts.next();
      if (!nextRaw) break;
      const nextSSML = await this.#preprocessSSML(nextRaw);
      if (!nextSSML) continue;
      const batch = await this.#buildRemoteBatchSSML(nextSSML);
      this.#remoteBatchQueue.push(batch);
    }
  }

  async #speak(
    ssml: string | undefined | Promise<string>,
    oneTime = false,
    fromRemoteQueue = false,
  ) {
    await this.stop();
    this.#currentSpeakAbortController = new AbortController();
    const { signal } = this.#currentSpeakAbortController;

    this.#currentSpeakPromise = new Promise(async (resolve, reject) => {
      try {
        console.log('TTS speak');
        this.state = 'playing';

        signal.addEventListener('abort', () => {
          resolve();
        });

        ssml = await this.#preprocessSSML(await ssml);
        if (!ssml) {
          this.#nossmlCnt++;
          // FIXME: in case we are at the end of the book, need a better way to handle this
          if (this.#nossmlCnt < 10 && this.state === 'playing' && !oneTime) {
            resolve();
            if (await this.#initTTSForNextSection()) {
              await this.forward();
            } else {
              await this.stop();
            }
          }
          console.log('no SSML, skipping for', this.#nossmlCnt);
          return;
        } else {
          this.#nossmlCnt = 0;
        }

        if (!oneTime && this.ttsClient.name === 'remote-tts') {
          this.#applyRemoteTuningFromSettings();
          if (!fromRemoteQueue) {
            ssml = await this.#buildRemoteBatchSSML(ssml);
          }
          await this.#fillRemoteBatchQueue();
        }

        const { plainText, marks } = parseSSMLMarks(ssml);
        if (!oneTime) {
          if (!plainText || marks.length === 0) {
            resolve();
            return await this.forward();
          } else {
            this.dispatchSpeakMark(marks[0]);
          }
          if (this.ttsClient.name !== 'remote-tts') {
            await this.preloadSSML(ssml, signal);
          }
        }
        const iter = await this.ttsClient.speak(ssml, signal);
        let lastCode;
        for await (const { code, message } of iter) {
          if (signal.aborted) {
            resolve();
            return;
          }
          lastCode = code;
          if (code === 'error') {
            throw new Error(message || 'TTS playback failed');
          }
        }

        if (lastCode === 'end' && this.state === 'playing' && !oneTime) {
          resolve();
          await this.forward();
        }
        resolve();
      } catch (e) {
        if (signal.aborted) {
          resolve();
        } else {
          reject(e);
        }
      } finally {
        if (this.#currentSpeakAbortController) {
          this.#currentSpeakAbortController.abort();
          this.#currentSpeakAbortController = null;
        }
      }
    });

    await this.#currentSpeakPromise.catch((e) => this.error(e));
  }

  async speak(ssml: string | Promise<string>, oneTime = false, oneTimeCallback?: () => void) {
    await this.initViewTTS();
    this.#speak(ssml, oneTime)
      .then(() => {
        if (oneTime && oneTimeCallback) {
          oneTimeCallback();
        }
      })
      .catch((e) => this.error(e));
    if (!oneTime) {
      if (this.ttsClient.name !== 'remote-tts') {
        this.preloadNextSSML();
      }
      this.dispatchSpeakMark();
    }
  }

  play() {
    if (this.state !== 'playing') {
      this.start();
    } else {
      this.pause();
    }
  }

  async start() {
    await this.initViewTTS();
    if (!this.state.includes('paused') && this.ttsClient.name === 'remote-tts') {
      this.#remoteBatchQueue = [];
    }
    const ssml = this.state.includes('paused') ? this.view.tts?.resume() : this.view.tts?.start();
    if (this.state.includes('paused')) {
      this.resume();
    }
    this.#speak(ssml);
    if (this.ttsClient.name !== 'remote-tts') {
      this.preloadNextSSML();
    }
  }

  async pause() {
    this.state = 'paused';
    if (!(await this.ttsClient.pause().catch((e) => this.error(e)))) {
      await this.stop();
      this.state = 'stop-paused';
    }
  }

  async resume() {
    this.state = 'playing';
    await this.ttsClient.resume().catch((e) => this.error(e));
  }

  async stop() {
    if (this.#currentSpeakAbortController) {
      this.#currentSpeakAbortController.abort();
    }
    await this.ttsClient.stop().catch((e) => this.error(e));

    if (this.#currentSpeakPromise) {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stop operation timed out')), 3000),
      );
      await Promise.race([this.#currentSpeakPromise.catch((e) => this.error(e)), timeout]).catch(
        (e) => this.error(e),
      );
      this.#currentSpeakPromise = null;
    }
    this.state = 'stopped';
  }

  // goto previous mark/paragraph
  async backward(byMark = false) {
    await this.initViewTTS();
    const isPlaying = this.state === 'playing';
    await this.stop();
    this.#remoteBatchQueue = [];
    if (!isPlaying) this.state = 'backward-paused';

    const ssml = byMark ? this.view.tts?.prevMark(!isPlaying) : this.view.tts?.prev(!isPlaying);
    if (!ssml) {
      await this.#handleNavigationWithoutSSML(() => this.#initTTSForPrevSection(), isPlaying);
    } else {
      await this.#handleNavigationWithSSML(ssml, isPlaying);
    }
  }

  // goto next mark/paragraph
  async forward(byMark = false) {
    await this.initViewTTS();
    const isPlaying = this.state === 'playing';
    await this.stop();
    if (!isPlaying) this.state = 'forward-paused';

    let ssml: string | undefined;
    if (!byMark && this.ttsClient.name === 'remote-tts') {
      ssml = this.#remoteBatchQueue.shift();
      if (!ssml) {
        const nextSeed = await this.#preprocessSSML(this.view.tts?.next(!isPlaying));
        if (nextSeed) {
          ssml = await this.#buildRemoteBatchSSML(nextSeed);
        }
      }
      await this.#fillRemoteBatchQueue();
    } else {
      ssml = byMark ? this.view.tts?.nextMark(!isPlaying) : this.view.tts?.next(!isPlaying);
      if (byMark && this.ttsClient.name === 'remote-tts') {
        this.#remoteBatchQueue = [];
      }
    }
    if (!ssml) {
      await this.#handleNavigationWithoutSSML(() => this.#initTTSForNextSection(), isPlaying);
    } else {
      if (isPlaying && !byMark && this.ttsClient.name === 'remote-tts') {
        this.#speak(ssml, false, true);
      } else {
        await this.#handleNavigationWithSSML(ssml, isPlaying);
      }
    }
    if (isPlaying && !byMark && this.ttsClient.name !== 'remote-tts') this.preloadNextSSML();
  }

  async setLang(lang: string) {
    this.ttsLang = lang;
    this.setPrimaryLang(lang);
  }

  async setPrimaryLang(lang: string) {
    if (this.ttsEdgeClient.initialized) this.ttsEdgeClient.setPrimaryLang(lang);
    if (this.ttsWebClient.initialized) this.ttsWebClient.setPrimaryLang(lang);
    if (this.ttsNativeClient?.initialized) this.ttsNativeClient?.setPrimaryLang(lang);
    if (this.ttsRemoteClient.initialized) this.ttsRemoteClient.setPrimaryLang(lang);
  }

  async setRate(rate: number) {
    this.state = 'setrate-paused';
    this.ttsRate = rate;
    await this.ttsClient.setRate(this.ttsRate);
  }

  async getVoices(lang: string) {
    const ttsWebVoices = await this.ttsWebClient.getVoices(lang);
    const ttsEdgeVoices = await this.ttsEdgeClient.getVoices(lang);
    const ttsNativeVoices = (await this.ttsNativeClient?.getVoices(lang)) ?? [];
    const ttsRemoteVoices = (await this.ttsRemoteClient?.getVoices(lang)) ?? [];

    const voicesGroups = [
      ...ttsNativeVoices,
      ...ttsRemoteVoices,
      ...ttsEdgeVoices,
      ...ttsWebVoices,
    ];
    return voicesGroups;
  }

  async setVoice(voiceId: string, lang: string) {
    this.state = 'setvoice-paused';
    this.#remoteBatchQueue = [];
    const useEdgeTTS = !!this.ttsEdgeVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    const useNativeTTS = !!this.ttsNativeVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    const useRemoteTTS = !!this.ttsRemoteVoices.find(
      (voice) => (voiceId === '' || voice.id === voiceId) && !voice.disabled,
    );
    if (useEdgeTTS) {
      this.ttsClient = this.ttsEdgeClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else if (useNativeTTS) {
      if (!this.ttsNativeClient) {
        throw new Error('Native TTS client is not available');
      }
      this.ttsClient = this.ttsNativeClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else if (useRemoteTTS) {
      this.ttsClient = this.ttsRemoteClient;
      await this.ttsClient.setRate(this.ttsRate);
    } else {
      this.ttsClient = this.ttsWebClient;
      await this.ttsClient.setRate(this.ttsRate);
    }
    TTSUtils.setPreferredClient(this.ttsClient.name);
    TTSUtils.setPreferredVoice(this.ttsClient.name, lang, voiceId);
    await this.ttsClient.setVoice(voiceId);
  }

  getVoiceId() {
    return this.ttsClient.getVoiceId();
  }

  getSpeakingLang() {
    return this.ttsClient.getSpeakingLang();
  }

  setTargetLang(lang: string) {
    this.ttsTargetLang = lang;
  }

  dispatchSpeakMark(mark?: TTSMark) {
    this.dispatchEvent(new CustomEvent('tts-speak-mark', { detail: mark || { text: '' } }));
    if (mark && mark.name !== '-1') {
      if (this.#isPreloading) {
        setTimeout(() => this.dispatchSpeakMark(mark), 500);
      } else {
        const range = this.view.tts?.setMark(mark.name);
        try {
          const cfi = this.view.getCFI(this.#ttsSectionIndex, range);
          this.dispatchEvent(new CustomEvent('tts-highlight-mark', { detail: { cfi } }));
        } catch {}
      }
    }
  }

  error(e: unknown) {
    console.error(e);
    this.state = 'stopped';
  }

  async shutdown() {
    await this.stop();
    this.#clearHighlighter();
    this.#ttsSectionIndex = -1;
    if (this.ttsWebClient.initialized) {
      await this.ttsWebClient.shutdown();
    }
    if (this.ttsEdgeClient.initialized) {
      await this.ttsEdgeClient.shutdown();
    }
    if (this.ttsNativeClient?.initialized) {
      await this.ttsNativeClient.shutdown();
    }
    if (this.ttsRemoteClient.initialized) {
      await this.ttsRemoteClient.shutdown();
    }
  }
}
