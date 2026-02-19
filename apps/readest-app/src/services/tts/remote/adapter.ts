import { TTSProviderProfile } from '@/types/settings';
import { REMOTE_TTS_ERROR_CODES, RemoteTTSErrorCode } from '@/services/tts/providerSettings';
import { TTSVoice } from '@/services/tts/types';

export interface RemoteTTSHealthResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
  models?: string[];
}

export interface RemoteTTSSynthesisParams {
  input: string;
  model: string;
  voice: string;
  speed?: number;
  responseFormat?: 'mp3' | 'wav';
}

export interface RemoteTTSSynthesisResult {
  contentType: string;
  data: ArrayBuffer;
}

export class RemoteTTSAdapterError extends Error {
  code: RemoteTTSErrorCode;
  status: number;
  details?: unknown;

  constructor(code: RemoteTTSErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'RemoteTTSAdapterError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface RemoteTTSAdapter {
  readonly type: TTSProviderProfile['type'];
  health(provider: TTSProviderProfile): Promise<RemoteTTSHealthResult>;
  listVoices(provider: TTSProviderProfile, lang?: string): Promise<TTSVoice[]>;
  synthesize(
    provider: TTSProviderProfile,
    params: RemoteTTSSynthesisParams,
  ): Promise<RemoteTTSSynthesisResult>;
}

const mapHttpStatusToErrorCode = (status: number): RemoteTTSErrorCode => {
  if (status === 401) return REMOTE_TTS_ERROR_CODES.Unauthorized;
  if (status === 403) return REMOTE_TTS_ERROR_CODES.Forbidden;
  if (status === 429) return REMOTE_TTS_ERROR_CODES.RateLimited;
  if (status >= 400 && status < 500) return REMOTE_TTS_ERROR_CODES.InvalidRequest;
  return REMOTE_TTS_ERROR_CODES.UpstreamError;
};

const safeJsonParse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

export const fetchJsonWithTimeout = async (
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RemoteTTSAdapterError(
        REMOTE_TTS_ERROR_CODES.Timeout,
        `Request timed out after ${timeoutMs}ms`,
        504,
      );
    }
    throw new RemoteTTSAdapterError(
      REMOTE_TTS_ERROR_CODES.NetworkError,
      error instanceof Error ? error.message : 'Network request failed',
      502,
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
};

export const assertOkResponse = async (response: Response): Promise<void> => {
  if (response.ok) return;
  const details = await safeJsonParse(response);
  throw new RemoteTTSAdapterError(
    mapHttpStatusToErrorCode(response.status),
    `Remote provider request failed with status ${response.status}`,
    response.status,
    details,
  );
};
