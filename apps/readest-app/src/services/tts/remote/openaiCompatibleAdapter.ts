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

const trimTrailingSlash = (baseUrl: string): string => {
  return baseUrl.replace(/\/+$/, '');
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

  async listVoices(provider: TTSProviderProfile, lang = 'en-US'): Promise<TTSVoice[]> {
    await this.health(provider);
    return DEFAULT_OPENAI_VOICES.map((voiceId) => ({
      id: voiceId,
      name: voiceId,
      lang,
    }));
  }

  private buildSpeechPayload(provider: TTSProviderProfile, params: RemoteTTSSynthesisParams) {
    const model = params.model || provider.model;
    const voice = params.voice || provider.defaultVoice;
    if (!params.input || !model || !voice) {
      throw new RemoteTTSAdapterError(
        REMOTE_TTS_ERROR_CODES.InvalidRequest,
        'input, model and voice are required',
        400,
      );
    }
    return {
      model,
      input: params.input,
      voice,
      speed: params.speed ?? 1.0,
      response_format: params.responseFormat ?? 'mp3',
      stream: params.stream === true,
    };
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
