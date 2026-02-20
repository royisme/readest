import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as healthPost } from '@/app/api/tts/remote/health/route';
import { POST as voicesPost } from '@/app/api/tts/remote/voices/route';
import { POST as speechPost } from '@/app/api/tts/remote/speech/route';
import { RemoteTTSAdapterError } from '@/services/tts/remote/adapter';
import { REMOTE_TTS_ERROR_CODES } from '@/services/tts/providerSettings';

vi.mock('@/utils/access', () => ({
  validateUserAndToken: vi.fn(),
}));

vi.mock('@/services/tts/remote/factory', () => ({
  getRemoteTTSAdapter: vi.fn(),
}));

import { validateUserAndToken } from '@/utils/access';
import { getRemoteTTSAdapter } from '@/services/tts/remote/factory';

const mockedValidateUserAndToken = vi.mocked(validateUserAndToken);
const mockedGetRemoteTTSAdapter = vi.mocked(getRemoteTTSAdapter);

const providerPayload = {
  id: 'provider-1',
  name: 'OpenAI Compatible',
  type: 'openai_compatible' as const,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini-tts',
  defaultVoice: 'alloy',
  enabled: true,
};

describe('/api/tts/remote/* routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('health returns 403 when unauthenticated', async () => {
    mockedValidateUserAndToken.mockResolvedValue({});
    const request = new NextRequest('http://localhost:3000/api/tts/remote/health', {
      method: 'POST',
      body: JSON.stringify({ provider: providerPayload }),
    });

    const response = await healthPost(request);
    expect(response.status).toBe(403);
  });

  it('health returns latency and models on success', async () => {
    mockedValidateUserAndToken.mockResolvedValue({ user: { id: 'u' } as never, token: 't' });
    mockedGetRemoteTTSAdapter.mockReturnValue({
      type: 'openai_compatible',
      health: vi.fn().mockResolvedValue({
        ok: true,
        latencyMs: 88,
        models: ['gpt-4o-mini-tts'],
      }),
      listVoices: vi.fn(),
      synthesizeStream: vi.fn(),
      synthesize: vi.fn(),
    });

    const request = new NextRequest('http://localhost:3000/api/tts/remote/health', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: providerPayload }),
    });

    const response = await healthPost(request);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.result.latencyMs).toBe(88);
  });

  it('voices returns normalized list', async () => {
    mockedValidateUserAndToken.mockResolvedValue({ user: { id: 'u' } as never, token: 't' });
    mockedGetRemoteTTSAdapter.mockReturnValue({
      type: 'openai_compatible',
      health: vi.fn(),
      listVoices: vi.fn().mockResolvedValue([
        { id: 'alloy', name: 'alloy', lang: 'en-US' },
        { id: 'nova', name: 'nova', lang: 'en-US' },
      ]),
      synthesizeStream: vi.fn(),
      synthesize: vi.fn(),
    });

    const request = new NextRequest('http://localhost:3000/api/tts/remote/voices', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: providerPayload, lang: 'en' }),
    });
    const response = await voicesPost(request);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.voices).toHaveLength(2);
  });

  it('speech returns 400 for missing input', async () => {
    mockedValidateUserAndToken.mockResolvedValue({ user: { id: 'u' } as never, token: 't' });

    const request = new NextRequest('http://localhost:3000/api/tts/remote/speech', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: providerPayload }),
    });
    const response = await speechPost(request);
    expect(response.status).toBe(400);
  });

  it('speech maps adapter timeout error to 504', async () => {
    mockedValidateUserAndToken.mockResolvedValue({ user: { id: 'u' } as never, token: 't' });
    mockedGetRemoteTTSAdapter.mockReturnValue({
      type: 'openai_compatible',
      health: vi.fn(),
      listVoices: vi.fn(),
      synthesizeStream: vi.fn(),
      synthesize: vi
        .fn()
        .mockRejectedValue(
          new RemoteTTSAdapterError(
            REMOTE_TTS_ERROR_CODES.Timeout,
            'Request timed out after 30000ms',
            504,
          ),
        ),
    });

    const request = new NextRequest('http://localhost:3000/api/tts/remote/speech', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: providerPayload, input: 'hello' }),
    });
    const response = await speechPost(request);
    const data = await response.json();
    expect(response.status).toBe(504);
    expect(data.error.code).toBe(REMOTE_TTS_ERROR_CODES.Timeout);
  });

  it('speech returns audio payload on success', async () => {
    mockedValidateUserAndToken.mockResolvedValue({ user: { id: 'u' } as never, token: 't' });
    mockedGetRemoteTTSAdapter.mockReturnValue({
      type: 'openai_compatible',
      health: vi.fn(),
      listVoices: vi.fn(),
      synthesizeStream: vi.fn(),
      synthesize: vi.fn().mockResolvedValue({
        contentType: 'audio/mpeg',
        data: new Uint8Array([1, 2, 3]).buffer,
      }),
    });

    const request = new NextRequest('http://localhost:3000/api/tts/remote/speech', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: providerPayload, input: 'hello' }),
    });
    const response = await speechPost(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio');
    const arrayBuffer = await response.arrayBuffer();
    expect(arrayBuffer.byteLength).toBe(3);
  });

  it('speech forwards responseFormat and stream to adapter', async () => {
    mockedValidateUserAndToken.mockResolvedValue({ user: { id: 'u' } as never, token: 't' });
    const synthesize = vi.fn();
    const synthesizeStream = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav' } }),
      );
    mockedGetRemoteTTSAdapter.mockReturnValue({
      type: 'openai_compatible',
      health: vi.fn(),
      listVoices: vi.fn(),
      synthesizeStream,
      synthesize,
    });

    const request = new NextRequest('http://localhost:3000/api/tts/remote/speech', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: { ...providerPayload, responseFormat: 'wav', stream: true },
        input: 'hello',
        responseFormat: 'wav',
        stream: true,
      }),
    });

    const response = await speechPost(request);
    expect(response.status).toBe(200);
    expect(synthesizeStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        responseFormat: 'wav',
        stream: true,
      }),
    );
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('speech returns streamed body when stream mode is enabled', async () => {
    mockedValidateUserAndToken.mockResolvedValue({ user: { id: 'u' } as never, token: 't' });
    mockedGetRemoteTTSAdapter.mockReturnValue({
      type: 'openai_compatible',
      health: vi.fn(),
      listVoices: vi.fn(),
      synthesize: vi.fn(),
      synthesizeStream: vi.fn().mockResolvedValue(
        new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: {
            'Content-Type': 'audio/wav',
            'x-sample-rate': '44100',
          },
        }),
      ),
    });

    const request = new NextRequest('http://localhost:3000/api/tts/remote/speech', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: { ...providerPayload, stream: true, responseFormat: 'wav' },
        input: 'hello',
        stream: true,
        responseFormat: 'wav',
      }),
    });

    const response = await speechPost(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(response.headers.get('x-sample-rate')).toBe('44100');
    const data = await response.arrayBuffer();
    expect(data.byteLength).toBe(3);
  });
});
