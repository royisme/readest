import { getUserLocale } from '@/utils/misc';
import { fetchWithOptionalAuth } from '@/utils/fetch';
import { parseSSMLMarks } from '@/utils/ssml';
import { isTauriAppPlatform } from '@/services/environment';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { TTSProviderProfile, TTSSettings } from '@/types/settings';
import { buildRemoteTTSSegments } from './remote/textSegmenter';
import { getRemoteTTSAdapter } from './remote/factory';

const REMOTE_VOICE_PREFIX = 'remote-tts:';

const encodeRemoteVoiceId = (providerId: string, voiceId: string): string => {
  return `${REMOTE_VOICE_PREFIX}${providerId}:${voiceId}`;
};

const decodeRemoteVoiceId = (value: string): { providerId: string; voiceId: string } | null => {
  if (!value.startsWith(REMOTE_VOICE_PREFIX)) return null;
  const payload = value.slice(REMOTE_VOICE_PREFIX.length);
  const idx = payload.indexOf(':');
  if (idx <= 0) return null;
  const providerId = payload.slice(0, idx);
  const voiceId = payload.slice(idx + 1);
  if (!providerId || !voiceId) return null;
  return { providerId, voiceId };
};

export class RemoteTTSClient implements TTSClient {
  name = 'remote-tts';
  initialized = false;
  controller?: TTSController;
  getTTSSettings: () => TTSSettings | null;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = '';
  #rate = 1.0;
  #isStopped = false;
  #audioElement: HTMLAudioElement | null = null;
  #preferredSegmentMaxChars = 90;
  #absoluteSegmentMaxChars = 500;
  #minSegmentChars = 40;
  #prefetchWindowSize = 4;

  constructor(controller?: TTSController, getTTSSettings?: () => TTSSettings | null) {
    this.controller = controller;
    this.getTTSSettings = getTTSSettings || (() => null);
  }

  getActiveProvider(settings?: TTSSettings | null): TTSProviderProfile | null {
    const ttsSettings = settings || this.getTTSSettings();
    if (!ttsSettings?.activeProviderId) return null;
    return (
      ttsSettings.providers.find(
        (provider) => provider.id === ttsSettings.activeProviderId && provider.enabled,
      ) || null
    );
  }

  async init() {
    const provider = this.getActiveProvider();
    this.initialized = !!provider;
    return this.initialized;
  }

  async *speak(
    ssml: string,
    signal: AbortSignal,
    preload = false,
  ): AsyncGenerator<TTSMessageEvent> {
    if (preload) {
      yield { code: 'end', message: 'Preload skipped for remote TTS' };
      return;
    }

    this.#isStopped = false;
    const provider = this.getActiveProvider();
    if (!provider) {
      yield { code: 'error', message: 'No active remote provider configured' };
      return;
    }

    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    const segments = buildRemoteTTSSegments(marks, {
      preferredMaxChars: this.#preferredSegmentMaxChars,
      absoluteMaxChars: this.#absoluteSegmentMaxChars,
      minCharsPerSegment: this.#minSegmentChars,
    });

    const decoded = decodeRemoteVoiceId(this.#currentVoiceId);
    const cachedVoiceIds = (provider.cachedVoices || []).map((voice) => voice.id);
    let selectedVoice =
      decoded && decoded.providerId === provider.id ? decoded.voiceId : provider.defaultVoice;
    if (cachedVoiceIds.length > 0 && !cachedVoiceIds.includes(selectedVoice)) {
      selectedVoice = cachedVoiceIds[0]!;
    }
    const responseFormat = provider.responseFormat || 'mp3';
    const stream = !!provider.stream;
    // On Tauri mobile, chunked streaming responses are not consistently playable across devices.
    // Fallback to buffered synthesis while keeping segment prefetch to preserve continuity.
    const useStreamingTransport = stream && !isTauriAppPlatform();
    const adapter = getRemoteTTSAdapter(provider);

    const requestAudioResponse = async (segmentText: string): Promise<Response> => {
      if (isTauriAppPlatform()) {
        if (useStreamingTransport) {
          return await adapter.synthesizeStream(provider, {
            input: segmentText,
            model: provider.model,
            voice: selectedVoice,
            speed: this.#rate,
            responseFormat,
            stream: useStreamingTransport,
          });
        }
        const result = await adapter.synthesize(provider, {
          input: segmentText,
          model: provider.model,
          voice: selectedVoice,
          speed: this.#rate,
          responseFormat,
          stream: useStreamingTransport,
        });
        return new Response(result.data, {
          status: 200,
          headers: { 'Content-Type': result.contentType },
        });
      }
      return await fetchWithOptionalAuth('/api/tts/remote/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          input: segmentText,
          model: provider.model,
          voice: selectedVoice,
          speed: this.#rate,
          responseFormat,
          stream: useStreamingTransport,
        }),
      });
    };

    const normalizeMimeType = (contentType: string, fallback: 'audio/mpeg' | 'audio/wav') => {
      return contentType.split(';')[0]?.trim() || fallback;
    };

    const playBufferedResponse = async (response: Response) => {
      const mimeType = normalizeMimeType(
        response.headers.get('content-type') || '',
        responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
      );
      const data = await response.arrayBuffer();
      const blob = new Blob([data], { type: mimeType });
      const audioUrl = URL.createObjectURL(blob);
      try {
        await new Promise<void>((resolve, reject) => {
          const audio = this.#audioElement || new Audio();
          if (!this.#audioElement) {
            this.#audioElement = audio;
            audio.preload = 'auto';
            audio.setAttribute('playsinline', 'true');
          }
          audio.src = audioUrl;
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error('Audio playback error'));
          audio.playbackRate = this.#rate;
          audio.play().catch(reject);
        });
      } finally {
        URL.revokeObjectURL(audioUrl);
      }
    };

    const playStreamedResponse = async (response: Response) => {
      const fallbackMime = responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const mimeType = normalizeMimeType(response.headers.get('content-type') || '', fallbackMime);
      const body = response.body;
      const canUseStreamPlayback =
        !!body &&
        typeof window !== 'undefined' &&
        'MediaSource' in window &&
        typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported(mimeType);

      if (!canUseStreamPlayback) {
        await playBufferedResponse(response);
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const mediaSource = new MediaSource();
        const audio = new Audio();
        const objectUrl = URL.createObjectURL(mediaSource);
        const reader = body.getReader();
        const chunkQueue: Uint8Array[] = [];
        let sourceBuffer: SourceBuffer | null = null;
        let streamDone = false;
        let finished = false;

        const cleanup = () => {
          if (finished) return;
          finished = true;
          audio.onended = null;
          audio.onerror = null;
          URL.revokeObjectURL(objectUrl);
          reader.cancel().catch(() => {});
        };

        const fail = (error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error('Audio stream playback error'));
        };

        const finalizeStream = () => {
          if (!sourceBuffer || sourceBuffer.updating || !streamDone) return;
          if (mediaSource.readyState === 'open') {
            try {
              mediaSource.endOfStream();
            } catch {}
          }
        };

        const flushQueue = () => {
          if (!sourceBuffer || sourceBuffer.updating || chunkQueue.length === 0) return;
          try {
            const chunk = chunkQueue.shift()!;
            const normalizedChunk = new Uint8Array(chunk);
            sourceBuffer.appendBuffer(normalizedChunk);
          } catch (error) {
            fail(error);
          }
        };

        signal.addEventListener('abort', () => {
          cleanup();
          reject(new Error('Aborted'));
        });

        audio.onended = () => {
          cleanup();
          resolve();
        };
        audio.onerror = () => fail(new Error('Audio playback error'));
        audio.src = objectUrl;
        audio.playbackRate = this.#rate;

        mediaSource.addEventListener('sourceopen', () => {
          try {
            sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBuffer.mode = 'sequence';
            sourceBuffer.addEventListener('updateend', () => {
              flushQueue();
              finalizeStream();
            });
            audio.play().catch((error) => fail(error));

            (async () => {
              try {
                while (true) {
                  if (signal.aborted || this.#isStopped) {
                    cleanup();
                    reject(new Error('Aborted'));
                    return;
                  }
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) {
                    chunkQueue.push(value);
                    flushQueue();
                  }
                }
                streamDone = true;
                finalizeStream();
              } catch (error) {
                fail(error);
              }
            })();
          } catch (error) {
            fail(error);
          }
        });
      });
    };

    if (useStreamingTransport) {
      const streamResponsePromises = new Map<number, Promise<Response>>();
      const getOrCreateStreamResponsePromise = (index: number): Promise<Response> => {
        if (streamResponsePromises.has(index)) {
          return streamResponsePromises.get(index)!;
        }
        const segment = segments[index];
        if (!segment) {
          return Promise.reject(new Error('Invalid segment index'));
        }
        const promise = requestAudioResponse(segment.text);
        promise.catch(() => {
          // keep prefetched request rejections from becoming unhandled;
          // errors are surfaced when the segment is actually awaited.
        });
        streamResponsePromises.set(index, promise);
        return promise;
      };

      const warmupStreamResponses = (startIndex: number) => {
        const endExclusive = Math.min(segments.length, startIndex + this.#prefetchWindowSize);
        for (let idx = startIndex; idx < endExclusive; idx++) {
          getOrCreateStreamResponsePromise(idx);
        }
      };

      warmupStreamResponses(0);

      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex]!;
        if (signal.aborted || this.#isStopped) {
          yield { code: 'error', message: 'Aborted' };
          return;
        }
        this.#speakingLang = segment.language || this.#primaryLang;
        this.controller?.dispatchSpeakMark(segment.anchorMark);
        yield {
          code: 'boundary',
          mark: segment.anchorMark.name,
          message: `Start chunk: ${segment.anchorMark.name}`,
        };

        try {
          warmupStreamResponses(segmentIndex + 1);
          const response = await getOrCreateStreamResponsePromise(segmentIndex);
          streamResponsePromises.delete(segmentIndex);
          await playStreamedResponse(response);
        } catch (error) {
          yield {
            code: 'error',
            message: error instanceof Error ? error.message : 'Remote TTS failed',
          };
          return;
        }
      }
      yield { code: 'end', message: 'Speech finished' };
      return;
    }

    const requestAudioBuffer = async (
      segmentText: string,
    ): Promise<{ data: ArrayBuffer; contentType: string }> => {
      const response = await requestAudioResponse(segmentText);
      return {
        data: await response.arrayBuffer(),
        contentType: response.headers.get('content-type') || '',
      };
    };

    const audioBufferPromises = new Map<
      number,
      Promise<{ data: ArrayBuffer; contentType: string }>
    >();
    const getOrCreateAudioPromise = (
      index: number,
    ): Promise<{ data: ArrayBuffer; contentType: string }> => {
      if (audioBufferPromises.has(index)) {
        return audioBufferPromises.get(index)!;
      }
      const segment = segments[index];
      if (!segment) {
        return Promise.reject(new Error('Invalid segment index'));
      }
      const promise = requestAudioBuffer(segment.text);
      promise.catch(() => {
        // keep prefetched request rejections from becoming unhandled;
        // errors are surfaced when the segment is actually awaited.
      });
      audioBufferPromises.set(index, promise);
      return promise;
    };

    const warmupAudioRequests = (startIndex: number) => {
      const endExclusive = Math.min(segments.length, startIndex + this.#prefetchWindowSize);
      for (let idx = startIndex; idx < endExclusive; idx++) {
        getOrCreateAudioPromise(idx);
      }
    };

    warmupAudioRequests(0);

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex]!;
      if (signal.aborted || this.#isStopped) {
        yield { code: 'error', message: 'Aborted' };
        return;
      }
      this.#speakingLang = segment.language || this.#primaryLang;
      this.controller?.dispatchSpeakMark(segment.anchorMark);
      yield {
        code: 'boundary',
        mark: segment.anchorMark.name,
        message: `Start chunk: ${segment.anchorMark.name}`,
      };

      try {
        warmupAudioRequests(segmentIndex + 1);
        const audioBufferResult = await getOrCreateAudioPromise(segmentIndex);
        audioBufferPromises.delete(segmentIndex);
        if (signal.aborted || this.#isStopped) {
          yield { code: 'error', message: 'Aborted' };
          return;
        }

        const mimeType = normalizeMimeType(
          audioBufferResult.contentType,
          responseFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
        );
        const blob = new Blob([audioBufferResult.data], { type: mimeType });
        const audioUrl = URL.createObjectURL(blob);
        try {
          await new Promise<void>((resolve, reject) => {
            const audio = new Audio(audioUrl);
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error('Audio playback error'));
            audio.playbackRate = this.#rate;
            audio.play().catch(reject);
          });
        } finally {
          URL.revokeObjectURL(audioUrl);
        }
      } catch (error) {
        yield {
          code: 'error',
          message: error instanceof Error ? error.message : 'Remote TTS failed',
        };
        return;
      }
    }

    yield { code: 'end', message: 'Speech finished' };
  }

  async pause() {
    return false;
  }

  async resume() {
    return false;
  }

  async stop() {
    this.#isStopped = true;
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.onended = null;
      this.#audioElement.onerror = null;
      this.#audioElement.src = '';
    }
  }

  setPrimaryLang(lang: string) {
    this.#primaryLang = lang;
  }

  async setRate(rate: number) {
    this.#rate = rate;
  }

  async setPitch(pitch: number) {
    void pitch;
  }

  async setVoice(voice: string) {
    const selectedVoice = this.#voices.find((v) => v.id === voice);
    if (selectedVoice) {
      this.#currentVoiceId = selectedVoice.id;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    const provider = this.getActiveProvider();
    if (!provider) {
      this.#voices = [];
      return [];
    }
    const adapter = getRemoteTTSAdapter(provider);
    if (provider.cachedVoices && provider.cachedVoices.length > 0) {
      this.#voices = provider.cachedVoices.map((voice) => ({
        id: encodeRemoteVoiceId(provider.id, voice.id),
        name: voice.name,
        lang: voice.lang,
        disabled: !this.initialized,
      }));
      return this.#voices;
    }

    try {
      if (isTauriAppPlatform()) {
        const voices = await adapter.listVoices(provider);
        this.#voices = voices.map((voice: TTSVoice) => ({
          id: encodeRemoteVoiceId(provider.id, voice.id),
          name: voice.name,
          lang: voice.lang,
          disabled: !this.initialized,
        }));
        return this.#voices;
      }

      const response = await fetchWithOptionalAuth('/api/tts/remote/voices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
        }),
      });
      const payload = await response.json();
      const voices = Array.isArray(payload?.voices) ? payload.voices : [];
      this.#voices = voices.map((voice: TTSVoice) => ({
        id: encodeRemoteVoiceId(provider.id, voice.id),
        name: voice.name,
        lang: voice.lang,
        disabled: !this.initialized,
      }));
      return this.#voices;
    } catch {
      this.#voices = [];
      return [];
    }
  }

  async getVoices(lang: string) {
    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
    const voices = await this.getAllVoices();
    const filteredVoices = voices.filter(
      (v) => v.lang.startsWith(locale) || (lang === 'en' && ['en-US', 'en-GB'].includes(v.lang)),
    );
    const displayVoices = filteredVoices.length > 0 ? filteredVoices : voices;

    const voicesGroup: TTSVoicesGroup = {
      id: 'remote-tts',
      name: 'Remote TTS',
      voices: displayVoices.sort(TTSUtils.sortVoicesFunc),
      disabled: !this.initialized || displayVoices.length === 0,
    };

    return [voicesGroup];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return this.#currentVoiceId;
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    this.#voices = [];
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.src = '';
      this.#audioElement = null;
    }
  }
}
