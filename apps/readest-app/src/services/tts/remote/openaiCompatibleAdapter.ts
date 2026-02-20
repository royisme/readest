import { TTSProviderProfile } from '@/types/settings';
import { REMOTE_TTS_ERROR_CODES } from '@/services/tts/providerSettings';
import { TTSVoice } from '@/services/tts/types';
import {
  assertOkResponse,
  fetchJsonWithTimeout,
  fetchStreamWithTimeout,
  RemoteTTSAdapter,
  RemoteTTSAdapterError,
  RemoteTTSHealthResult,
  RemoteTTSSynthesisParams,
  RemoteTTSSynthesisResult,
} from './adapter';

type OpenAIModelsResponse = {
  data?: Array<{ id?: string }>;
};
type OpenAIVoicesResponse = {
  voices?: Array<{ id?: string; name?: string; lang?: string }>;
};

const trimTrailingSlash = (baseUrl: string): string => {
  return baseUrl.replace(/\/+$/, '');
};

const isKnownOpenAIDomain = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'api.openai.com';
  } catch {
    return false;
  }
};

const buildHeaders = (provider: TTSProviderProfile): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  if (provider.headers) {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (!key || !value) continue;
      headers[key] = value;
    }
  }

  return headers;
};

const toModelIds = (payload: unknown): string[] => {
  const data = (payload as OpenAIModelsResponse)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (typeof item?.id === 'string' ? item.id : ''))
    .filter((id) => id.length > 0);
};

const DEFAULT_OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
];

export class OpenAICompatibleAdapter implements RemoteTTSAdapter {
  readonly type = 'openai_compatible' as const;

  async health(provider: TTSProviderProfile): Promise<RemoteTTSHealthResult> {
    const timeoutMs = provider.timeoutMs ?? 30000;
    const baseUrl = trimTrailingSlash(provider.baseUrl);
    if (!baseUrl) {
      throw new RemoteTTSAdapterError(
        REMOTE_TTS_ERROR_CODES.InvalidProvider,
        'Provider baseUrl is required',
        400,
      );
    }

    const startedAt = Date.now();
    const response = await fetchJsonWithTimeout(
      `${baseUrl}/models`,
      {
        method: 'GET',
        headers: buildHeaders(provider),
      },
      timeoutMs,
    );
    await assertOkResponse(response);
    const payload = await response.json();
    const models = toModelIds(payload);

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: 'Provider health check passed',
      models,
    };
  }

  async listVoices(provider: TTSProviderProfile, lang?: string): Promise<TTSVoice[]> {
    const timeoutMs = provider.timeoutMs ?? 30000;
    const baseUrl = trimTrailingSlash(provider.baseUrl);
    const queryLang = typeof lang === 'string' ? lang.trim() : '';
    if (!baseUrl) {
      throw new RemoteTTSAdapterError(
        REMOTE_TTS_ERROR_CODES.InvalidProvider,
        'Provider baseUrl is required',
        400,
      );
    }

    try {
      const url = queryLang
        ? `${baseUrl}/audio/voices?lang=${encodeURIComponent(queryLang)}`
        : `${baseUrl}/audio/voices`;
      const response = await fetchJsonWithTimeout(
        url,
        {
          method: 'GET',
          headers: buildHeaders(provider),
        },
        timeoutMs,
      );
      await assertOkResponse(response);
      const payload = (await response.json()) as OpenAIVoicesResponse;
      const voices = Array.isArray(payload?.voices) ? payload.voices : [];
      const normalized = voices
        .map((voice) => ({
          id: typeof voice?.id === 'string' ? voice.id : '',
          name: typeof voice?.name === 'string' ? voice.name : '',
          lang:
            typeof voice?.lang === 'string' && voice.lang.length > 0
              ? voice.lang
              : queryLang || 'en',
        }))
        .filter((voice) => voice.id.length > 0)
        .map((voice) => ({
          id: voice.id,
          name: voice.name || voice.id,
          lang: voice.lang,
        }));
      if (normalized.length > 0) return normalized;
    } catch {
      // Some providers only expose OpenAI-compatible /audio/speech and no voices endpoint.
      // Only fallback to built-in OpenAI voices for the official OpenAI endpoint.
    }

    if (isKnownOpenAIDomain(baseUrl)) {
      return DEFAULT_OPENAI_VOICES.map((voiceId) => ({
        id: voiceId,
        name: voiceId,
        lang: queryLang || 'en',
      }));
    }
    return [];
  }

  private buildSpeechPayload(provider: TTSProviderProfile, params: RemoteTTSSynthesisParams) {
    const model = params.model || provider.model;
    const voice = params.voice || provider.defaultVoice;
    if (!params.input) {
      throw new RemoteTTSAdapterError(
        REMOTE_TTS_ERROR_CODES.InvalidRequest,
        'input is required',
        400,
      );
    }
    const payload: Record<string, unknown> = {
      input: params.input,
      speed: params.speed ?? 1.0,
      response_format: params.responseFormat ?? 'mp3',
      stream: params.stream === true,
    };
    if (voice && voice.trim().length > 0) {
      payload['voice'] = voice;
    }
    if (model && model.trim().length > 0) {
      payload['model'] = model;
    }
    return payload;
  }

  async synthesizeStream(provider: TTSProviderProfile, params: RemoteTTSSynthesisParams) {
    const timeoutMs = provider.timeoutMs ?? 30000;
    const baseUrl = trimTrailingSlash(provider.baseUrl);
    if (!baseUrl) {
      throw new RemoteTTSAdapterError(
        REMOTE_TTS_ERROR_CODES.InvalidProvider,
        'Provider baseUrl is required',
        400,
      );
    }

    const response = await fetchStreamWithTimeout(
      `${baseUrl}/audio/speech`,
      {
        method: 'POST',
        headers: buildHeaders(provider),
        body: JSON.stringify(this.buildSpeechPayload(provider, params)),
      },
      timeoutMs,
    );
    await assertOkResponse(response);
    return response;
  }

  async synthesize(
    provider: TTSProviderProfile,
    params: RemoteTTSSynthesisParams,
  ): Promise<RemoteTTSSynthesisResult> {
    const timeoutMs = provider.timeoutMs ?? 30000;
    const baseUrl = trimTrailingSlash(provider.baseUrl);
    if (!baseUrl) {
      throw new RemoteTTSAdapterError(
        REMOTE_TTS_ERROR_CODES.InvalidProvider,
        'Provider baseUrl is required',
        400,
      );
    }

    const response = await fetchJsonWithTimeout(
      `${baseUrl}/audio/speech`,
      {
        method: 'POST',
        headers: buildHeaders(provider),
        body: JSON.stringify(this.buildSpeechPayload(provider, params)),
      },
      timeoutMs,
    );
    await assertOkResponse(response);

    return {
      contentType: response.headers.get('content-type') || 'audio/mpeg',
      data: await response.arrayBuffer(),
    };
  }
}
