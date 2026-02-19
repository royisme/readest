import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_TTS_SETTINGS,
  mapLegacyClientToEngine,
  normalizeTTSSettings,
  readLegacyPreferredClient,
} from '@/services/tts/providerSettings';

describe('providerSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('falls back to default engine when settings and legacy values are missing', () => {
    const normalized = normalizeTTSSettings(undefined, null);
    expect(normalized).toEqual(DEFAULT_TTS_SETTINGS);
  });

  it('maps valid legacy client to default engine when ttsSettings is missing', () => {
    const normalized = normalizeTTSSettings(undefined, 'native-tts');
    expect(normalized.defaultEngine).toBe('native-tts');
  });

  it('keeps explicit valid defaultEngine instead of legacy value', () => {
    const normalized = normalizeTTSSettings(
      {
        defaultEngine: 'remote-tts',
        activeProviderId: null,
        providers: [],
      },
      'edge-tts',
    );
    expect(normalized.defaultEngine).toBe('remote-tts');
  });

  it('drops invalid providers and resets activeProviderId when provider does not exist', () => {
    const normalized = normalizeTTSSettings({
      defaultEngine: 'remote-tts',
      activeProviderId: 'provider-2',
      providers: [
        {
          id: 'provider-1',
          name: 'OpenAI Proxy',
          type: 'openai_compatible',
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-test',
          model: 'gpt-4o-mini-tts',
          defaultVoice: 'alloy',
          enabled: true,
          headers: {
            'x-project': 'readest',
            empty: '',
          },
          timeoutMs: 5000,
        },
        {
          id: '',
          name: 'Invalid',
          type: 'openai_compatible',
          baseUrl: '',
          enabled: true,
        },
      ],
    });

    expect(normalized.providers).toHaveLength(1);
    expect(normalized.providers[0]?.headers).toEqual({ 'x-project': 'readest' });
    expect(normalized.activeProviderId).toBeNull();
  });

  it('reads preferred client from legacy localStorage payload', () => {
    localStorage.setItem(
      'ttsPreferredVoices',
      JSON.stringify({
        preferredClient: 'web-speech',
      }),
    );
    expect(readLegacyPreferredClient()).toBe('web-speech');
  });

  it('returns null for invalid legacy payload', () => {
    localStorage.setItem('ttsPreferredVoices', 'not-json');
    expect(readLegacyPreferredClient()).toBeNull();
  });

  it('maps unknown legacy values to default engine', () => {
    expect(mapLegacyClientToEngine('unknown')).toBe('edge-tts');
  });
});
