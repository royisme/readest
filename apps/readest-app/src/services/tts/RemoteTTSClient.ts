import { getUserLocale } from '@/utils/misc';
import { fetchWithAuth } from '@/utils/fetch';
import { parseSSMLMarks } from '@/utils/ssml';
import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import { TTSProviderProfile, TTSSettings } from '@/types/settings';

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
    for (const mark of marks) {
      if (signal.aborted || this.#isStopped) {
        yield { code: 'error', message: 'Aborted' };
        return;
      }
      this.#speakingLang = mark.language || this.#primaryLang;
      this.controller?.dispatchSpeakMark(mark);
      yield { code: 'boundary', mark: mark.name, message: `Start chunk: ${mark.name}` };

      try {
        const decoded = decodeRemoteVoiceId(this.#currentVoiceId);
        const selectedVoice =
          decoded && decoded.providerId === provider.id ? decoded.voiceId : provider.defaultVoice;

        const response = await fetchWithAuth('/api/tts/remote/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            input: mark.text,
            model: provider.model,
            voice: selectedVoice,
            speed: this.#rate,
            responseFormat: 'mp3',
          }),
        });

        const audioBuffer = await response.arrayBuffer();
        if (signal.aborted || this.#isStopped) {
          yield { code: 'error', message: 'Aborted' };
          return;
        }

        const blob = new Blob([audioBuffer], { type: 'audio/mpeg' });
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

    try {
      const response = await fetchWithAuth('/api/tts/remote/voices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          lang: this.#primaryLang || getUserLocale('en') || 'en',
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

    const voicesGroup: TTSVoicesGroup = {
      id: 'remote-tts',
      name: 'Remote TTS',
      voices: filteredVoices.sort(TTSUtils.sortVoicesFunc),
      disabled: !this.initialized || filteredVoices.length === 0,
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
  }
}
