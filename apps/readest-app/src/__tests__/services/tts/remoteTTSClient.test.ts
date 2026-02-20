import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteTTSClient } from '@/services/tts/RemoteTTSClient';
import { TTSController } from '@/services/tts/TTSController';
import { TTSSettings } from '@/types/settings';

const fetchWithAuthMock = vi.fn();

vi.mock('@/utils/fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

class MockAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playbackRate = 1;

  async play() {
    queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  }
}

describe('RemoteTTSClient', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    );

    vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('should keep end event semantics for auto-next-chapter flow', async () => {
    const dispatchSpeakMark = vi.fn();
    const settings: TTSSettings = {
      defaultEngine: 'remote-tts',
      activeProviderId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          name: 'Provider',
          type: 'openai_compatible',
          baseUrl: 'https://example.com/v1',
          model: 'voxcpm-1.5',
          defaultVoice: 'default',
          timeoutMs: 30000,
          enabled: true,
        },
      ],
    };

    const controller = { dispatchSpeakMark } as unknown as TTSController;
    const client = new RemoteTTSClient(controller, () => settings);

    const ssml =
      '<speak xml:lang="zh-CN"><mark name="0"/>第一句。<mark name="1"/>第二句。<mark name="2"/>第三句。</speak>';
    const events: string[] = [];

    for await (const event of client.speak(ssml, new AbortController().signal, false)) {
      events.push(event.code);
    }

    expect(events.at(-1)).toBe('end');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(dispatchSpeakMark).toHaveBeenCalledTimes(1);
  });

  it('should prefetch upcoming segments without breaking end event', async () => {
    const dispatchSpeakMark = vi.fn();
    const settings: TTSSettings = {
      defaultEngine: 'remote-tts',
      activeProviderId: 'provider-1',
      providers: [
        {
          id: 'provider-1',
          name: 'Provider',
          type: 'openai_compatible',
          baseUrl: 'https://example.com/v1',
          model: 'voxcpm-1.5',
          defaultVoice: 'default',
          timeoutMs: 30000,
          enabled: true,
        },
      ],
    };

    let inFlight = 0;
    let maxInFlight = 0;
    fetchWithAuthMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    });

    const controller = { dispatchSpeakMark } as unknown as TTSController;
    const client = new RemoteTTSClient(controller, () => settings);

    const mk = (name: string, size: number) => `<mark name="${name}"/>${'甲'.repeat(size)}。`;
    const ssml = `<speak xml:lang="zh-CN">${mk('0', 130)}${mk('1', 130)}${mk('2', 130)}${mk('3', 130)}</speak>`;

    const events: string[] = [];
    for await (const event of client.speak(ssml, new AbortController().signal, false)) {
      events.push(event.code);
    }

    expect(events.at(-1)).toBe('end');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(4);
    expect(dispatchSpeakMark).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
