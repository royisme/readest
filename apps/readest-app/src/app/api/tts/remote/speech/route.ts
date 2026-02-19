import { NextRequest, NextResponse } from 'next/server';
import { validateUserAndToken } from '@/utils/access';
import {
  normalizeTTSProviderProfile,
  REMOTE_TTS_ERROR_CODES,
} from '@/services/tts/providerSettings';
import { RemoteTTSAdapterError } from '@/services/tts/remote/adapter';
import { getRemoteTTSAdapter } from '@/services/tts/remote/factory';

const toHttpStatus = (code: string, fallbackStatus: number): number => {
  if (code === REMOTE_TTS_ERROR_CODES.InvalidRequest) return 400;
  if (code === REMOTE_TTS_ERROR_CODES.InvalidProvider) return 400;
  if (code === REMOTE_TTS_ERROR_CODES.Unauthorized) return 401;
  if (code === REMOTE_TTS_ERROR_CODES.Forbidden) return 403;
  if (code === REMOTE_TTS_ERROR_CODES.RateLimited) return 429;
  if (code === REMOTE_TTS_ERROR_CODES.Timeout) return 504;
  if (code === REMOTE_TTS_ERROR_CODES.NetworkError) return 502;
  return fallbackStatus;
};

export async function POST(request: NextRequest) {
  const { user, token } = await validateUserAndToken(request.headers.get('authorization'));
  if (!user || !token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const provider = normalizeTTSProviderProfile(body?.provider);
    if (!provider) {
      return NextResponse.json(
        {
          error: {
            code: REMOTE_TTS_ERROR_CODES.InvalidProvider,
            message: 'Invalid provider payload',
          },
        },
        { status: 400 },
      );
    }

    if (!body?.input || typeof body.input !== 'string') {
      return NextResponse.json(
        {
          error: {
            code: REMOTE_TTS_ERROR_CODES.InvalidRequest,
            message: 'Missing or invalid "input" field',
          },
        },
        { status: 400 },
      );
    }

    const adapter = getRemoteTTSAdapter(provider);
    const result = await adapter.synthesize(provider, {
      input: body.input,
      model: typeof body.model === 'string' ? body.model : provider.model,
      voice: typeof body.voice === 'string' ? body.voice : provider.defaultVoice,
      speed: typeof body.speed === 'number' ? body.speed : 1.0,
      responseFormat: body.responseFormat === 'wav' ? 'wav' : 'mp3',
    });

    return new NextResponse(result.data, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.data.byteLength),
      },
    });
  } catch (error) {
    if (error instanceof RemoteTTSAdapterError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
            details: error.details ?? null,
          },
        },
        { status: toHttpStatus(error.code, error.status || 500) },
      );
    }

    return NextResponse.json(
      {
        error: {
          code: REMOTE_TTS_ERROR_CODES.UpstreamError,
          message: error instanceof Error ? error.message : 'Unknown remote TTS error',
        },
      },
      { status: 500 },
    );
  }
}
