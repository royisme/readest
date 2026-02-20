import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '@/services/tts/remote/openaiCompatibleAdapter';
import { REMOTE_TTS_ERROR_CODES } from '@/services/tts/providerSettings';

const buildProvider = () => ({
  id: 'provider-1',
  name: 'OpenAI',
  type: 'openai_compatible' as const,
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini-tts',
  defaultVoice: 'alloy',
  enabled: true,
  timeoutMs: 5000,
});

describe('OpenAICompatibleAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns models from /models health check', async () => {
    const adapter = new OpenAICompatibleAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-4o-mini-tts' }, { id: 'gpt-4o-realtime-preview' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await adapter.health(buildProvider());
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gpt-4o-mini-tts', 'gpt-4o-realtime-preview']);
  });

  it('throws invalid_provider when baseUrl is empty', async () => {
    const adapter = new OpenAICompatibleAdapter();
    await expect(
      adapter.health({
        ...buildProvider(),
        baseUrl: '',
      }),
    ).rejects.toMatchObject({
      code: REMOTE_TTS_ERROR_CODES.InvalidProvider,
      status: 400,
    });
  });

  it('maps 401 response to unauthorized error', async () => {
    const adapter = new OpenAICompatibleAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(adapter.health(buildProvider())).rejects.toMatchObject({
      code: REMOTE_TTS_ERROR_CODES.Unauthorized,
      status: 401,
    });
  });

  it('returns default voices for openai-compatible providers', async () => {
    const adapter = new OpenAICompatibleAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini-tts' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const voices = await adapter.listVoices(buildProvider());
    expect(voices.some((voice) => voice.id === 'alloy')).toBe(true);
  });

  it('synthesizes audio via /audio/speech', async () => {
    const adapter = new OpenAICompatibleAdapter();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })),
    );

    const result = await adapter.synthesize(buildProvider(), {
      input: 'hello',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      speed: 1.0,
    });
    expect(result.data.byteLength).toBe(4);
  });

  it('passes stream flag to upstream payload', async () => {
    const adapter = new OpenAICompatibleAdapter();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await adapter.synthesize(buildProvider(), {
      input: 'hello',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      responseFormat: 'wav',
      stream: true,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.response_format).toBe('wav');
    expect(payload.stream).toBe(true);
  });
});
