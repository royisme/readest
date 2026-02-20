import { TTSEngineType, TTSProviderProfile, TTSProviderType, TTSSettings } from '@/types/settings';

const LEGACY_TTS_PREFERENCES_KEY = 'ttsPreferredVoices';
const LEGACY_PREFERRED_CLIENT_KEY = 'preferredClient';

const VALID_ENGINES: TTSEngineType[] = ['edge-tts', 'web-speech', 'native-tts', 'remote-tts'];
const VALID_PROVIDER_TYPES: TTSProviderType[] = ['openai_compatible'];
const DEFAULT_TIMEOUT_MS = 30000;
const VALID_RESPONSE_FORMATS = ['mp3', 'wav'] as const;

export const REMOTE_TTS_ERROR_CODES = {
  InvalidRequest: 'invalid_request',
  InvalidProvider: 'invalid_provider',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  RateLimited: 'rate_limited',
  Timeout: 'timeout',
  NetworkError: 'network_error',
  UpstreamError: 'upstream_error',
} as const;

export type RemoteTTSErrorCode =
  (typeof REMOTE_TTS_ERROR_CODES)[keyof typeof REMOTE_TTS_ERROR_CODES];

export const DEFAULT_TTS_SETTINGS: TTSSettings = {
  defaultEngine: 'edge-tts',
  activeProviderId: null,
  providers: [],
};

export const mapLegacyClientToEngine = (legacyClient: string | null | undefined): TTSEngineType => {
  if (!legacyClient) return DEFAULT_TTS_SETTINGS.defaultEngine;
  return VALID_ENGINES.includes(legacyClient as TTSEngineType)
    ? (legacyClient as TTSEngineType)
    : DEFAULT_TTS_SETTINGS.defaultEngine;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const normalizeHeaderRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([k, v]) => k.trim().length > 0 && typeof v === 'string' && v.trim().length > 0)
    .map(([k, v]) => [k, v as string] as const);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
};

const normalizeCachedVoices = (
  value: unknown,
): NonNullable<TTSProviderProfile['cachedVoices']> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const voices = value
    .map((item) => {
      if (!isRecord(item)) return null;
      const id = typeof item['id'] === 'string' ? item['id'].trim() : '';
      const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
      const lang = typeof item['lang'] === 'string' ? item['lang'].trim() : '';
      if (!id) return null;
      return {
        id,
        name: name || id,
        lang: lang || 'en',
      };
    })
    .filter((voice): voice is { id: string; name: string; lang: string } => voice !== null);
  return voices.length > 0 ? voices : undefined;
};

export const normalizeTTSProviderProfile = (value: unknown): TTSProviderProfile | null => {
  if (!isRecord(value)) return null;

  const id = typeof value['id'] === 'string' ? value['id'].trim() : '';
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const type = typeof value['type'] === 'string' ? value['type'].trim() : '';
  const baseUrl = typeof value['baseUrl'] === 'string' ? value['baseUrl'].trim() : '';
  const apiKey = typeof value['apiKey'] === 'string' ? value['apiKey'].trim() : '';
  const model = typeof value['model'] === 'string' ? value['model'].trim() : '';
  const defaultVoice =
    typeof value['defaultVoice'] === 'string' ? value['defaultVoice'].trim() : '';
  const enabled = value['enabled'] !== false;
  const timeoutMs =
    typeof value['timeoutMs'] === 'number' &&
    Number.isFinite(value['timeoutMs']) &&
    value['timeoutMs'] > 0
      ? value['timeoutMs']
      : DEFAULT_TIMEOUT_MS;
  const responseFormatRaw =
    typeof value['responseFormat'] === 'string' ? value['responseFormat'].toLowerCase() : 'mp3';
  const responseFormat = VALID_RESPONSE_FORMATS.includes(
    responseFormatRaw as (typeof VALID_RESPONSE_FORMATS)[number],
  )
    ? (responseFormatRaw as (typeof VALID_RESPONSE_FORMATS)[number])
    : 'mp3';
  const stream = value['stream'] === true;

  if (!id || !name || !baseUrl) return null;
  if (!VALID_PROVIDER_TYPES.includes(type as TTSProviderType)) return null;

  return {
    id,
    name,
    type: type as TTSProviderType,
    baseUrl,
    apiKey,
    model,
    defaultVoice,
    enabled,
    timeoutMs,
    headers: normalizeHeaderRecord(value['headers']),
    responseFormat,
    stream,
    cachedVoices: normalizeCachedVoices(value['cachedVoices']),
  };
};

export const normalizeTTSSettings = (
  settings: unknown,
  legacyPreferredClient?: string | null,
): TTSSettings => {
  const input = isRecord(settings) ? settings : {};
  const fallbackEngine = mapLegacyClientToEngine(legacyPreferredClient);

  const defaultEngineRaw = input['defaultEngine'];
  const defaultEngine = VALID_ENGINES.includes(defaultEngineRaw as TTSEngineType)
    ? (defaultEngineRaw as TTSEngineType)
    : fallbackEngine;

  const providersRaw = Array.isArray(input['providers']) ? input['providers'] : [];
  const providers = providersRaw
    .map((provider) => normalizeTTSProviderProfile(provider))
    .filter((provider): provider is TTSProviderProfile => provider !== null);

  const activeProviderRaw =
    typeof input['activeProviderId'] === 'string' ? input['activeProviderId'] : null;
  const activeProviderId =
    activeProviderRaw && providers.some((provider) => provider.id === activeProviderRaw)
      ? activeProviderRaw
      : null;

  return {
    defaultEngine,
    activeProviderId,
    providers,
  };
};

export const readLegacyPreferredClient = (): string | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEGACY_TTS_PREFERENCES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const preferredClient = parsed[LEGACY_PREFERRED_CLIENT_KEY];
    return typeof preferredClient === 'string' ? preferredClient : null;
  } catch {
    return null;
  }
};
