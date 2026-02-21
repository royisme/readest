import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { SettingsPanelPanelProp } from './SettingsDialog';
import { z } from 'zod';
import {
  DEFAULT_REMOTE_CHUNK_HARD_LIMIT_CHARS,
  DEFAULT_REMOTE_CHUNK_MAX_SENTENCES,
  DEFAULT_REMOTE_CHUNK_TARGET_CHARS,
  DEFAULT_REMOTE_QUEUE_TARGET_SIZE,
  DEFAULT_TTS_SETTINGS,
  normalizeTTSProviderProfile,
  normalizeTTSSettings,
} from '@/services/tts/providerSettings';
import { RemoteTTSAdapterError } from '@/services/tts/remote/adapter';
import { getRemoteTTSAdapter } from '@/services/tts/remote/factory';
import { TTSAudioFormat, TTSProviderProfile, TTSEngineType, TTSSettings } from '@/types/settings';

type HealthStatus = 'idle' | 'testing' | 'success' | 'error';

type ProviderForm = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultVoice: string;
  enabled: boolean;
  timeoutMs: number;
  responseFormat: TTSAudioFormat;
  stream: boolean;
  remoteChunkMaxSentences: number;
  remoteChunkTargetChars: number;
  remoteChunkHardLimitChars: number;
  remoteQueueTargetSize: number;
};

const providerFormSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1, 'Provider ID is required')
      .regex(
        /^[a-zA-Z0-9._-]+$/,
        'Provider ID can only contain letters, numbers, ".", "_" and "-"',
      ),
    name: z.string().trim().min(1, 'Provider name is required'),
    baseUrl: z.string().trim().url('Base URL must be a valid URL'),
    apiKey: z.string().trim(),
    model: z.string().trim(),
    defaultVoice: z.string().trim(),
    enabled: z.boolean(),
    timeoutMs: z.number().int().min(1000, 'Timeout must be at least 1000ms'),
    responseFormat: z.enum(['mp3', 'wav']),
    stream: z.boolean(),
    remoteChunkMaxSentences: z.number().int().min(1).max(8),
    remoteChunkTargetChars: z.number().int().min(40).max(400),
    remoteChunkHardLimitChars: z.number().int().min(60).max(600),
    remoteQueueTargetSize: z.number().int().min(1).max(8),
  })
  .superRefine((value, ctx) => {
    if (value.remoteChunkHardLimitChars < value.remoteChunkTargetChars) {
      ctx.addIssue({
        path: ['remoteChunkHardLimitChars'],
        code: z.ZodIssueCode.custom,
        message: 'Hard limit must be greater than or equal to target chars',
      });
    }
  });

type ProviderFormErrorState = Partial<Record<keyof ProviderForm, string>> & {
  _form?: string;
};

const createProviderForm = (): ProviderForm => ({
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  defaultVoice: '',
  enabled: true,
  timeoutMs: 30000,
  responseFormat: 'mp3',
  stream: false,
  remoteChunkMaxSentences: DEFAULT_REMOTE_CHUNK_MAX_SENTENCES,
  remoteChunkTargetChars: DEFAULT_REMOTE_CHUNK_TARGET_CHARS,
  remoteChunkHardLimitChars: DEFAULT_REMOTE_CHUNK_HARD_LIMIT_CHARS,
  remoteQueueTargetSize: DEFAULT_REMOTE_QUEUE_TARGET_SIZE,
});

const toProviderProfile = (form: ProviderForm): TTSProviderProfile | null => {
  return normalizeTTSProviderProfile({
    id: form.id.trim(),
    name: form.name.trim(),
    type: 'openai_compatible',
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    defaultVoice: form.defaultVoice.trim(),
    enabled: form.enabled,
    timeoutMs: form.timeoutMs,
    responseFormat: form.responseFormat,
    stream: form.stream,
    remoteChunkMaxSentences: form.remoteChunkMaxSentences,
    remoteChunkTargetChars: form.remoteChunkTargetChars,
    remoteChunkHardLimitChars: form.remoteChunkHardLimitChars,
    remoteQueueTargetSize: form.remoteQueueTargetSize,
  });
};

const createProviderId = () => {
  return `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
};

const TTSSettingsPanel: React.FC<SettingsPanelPanelProp> = ({ onRegisterReset }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();

  const ttsSettings = useMemo<TTSSettings>(() => {
    return normalizeTTSSettings(settings.ttsSettings);
  }, [settings.ttsSettings]);

  const [providerForm, setProviderForm] = useState<ProviderForm>(createProviderForm);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerFormErrors, setProviderFormErrors] = useState<ProviderFormErrorState>({});
  const [healthStatuses, setHealthStatuses] = useState<Record<string, HealthStatus>>({});
  const [healthMessages, setHealthMessages] = useState<Record<string, string>>({});

  const parseNumberInput = (raw: string, fallback: number): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const normalizeFormNumber = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const persistTTSSettings = async (nextTTSSettings: TTSSettings) => {
    const nextSettings = { ...settings, ttsSettings: normalizeTTSSettings(nextTTSSettings) };
    setSettings(nextSettings);
    await saveSettings(envConfig, nextSettings);
  };

  const handleReset = () => {
    persistTTSSettings(DEFAULT_TTS_SETTINGS);
    setProviderForm(createProviderForm());
    setEditingProviderId(null);
    setProviderFormErrors({});
    setHealthStatuses({});
    setHealthMessages({});
  };

  useEffect(() => {
    onRegisterReset(handleReset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEngineChange = async (engine: TTSEngineType) => {
    await persistTTSSettings({
      ...ttsSettings,
      defaultEngine: engine,
    });
  };

  const resetProviderForm = () => {
    setProviderForm(createProviderForm());
    setEditingProviderId(null);
    setProviderFormErrors({});
  };

  const handleSaveProvider = async () => {
    const candidateId = editingProviderId || providerForm.id.trim() || createProviderId();
    const parsed = providerFormSchema.safeParse({
      ...providerForm,
      id: candidateId,
    });

    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setProviderFormErrors({
        id: fieldErrors.id?.[0],
        name: fieldErrors.name?.[0],
        baseUrl: fieldErrors.baseUrl?.[0],
        apiKey: fieldErrors.apiKey?.[0],
        model: fieldErrors.model?.[0],
        defaultVoice: fieldErrors.defaultVoice?.[0],
        timeoutMs: fieldErrors.timeoutMs?.[0],
        responseFormat: fieldErrors.responseFormat?.[0],
        stream: fieldErrors.stream?.[0],
        remoteChunkMaxSentences: fieldErrors.remoteChunkMaxSentences?.[0],
        remoteChunkTargetChars: fieldErrors.remoteChunkTargetChars?.[0],
        remoteChunkHardLimitChars: fieldErrors.remoteChunkHardLimitChars?.[0],
        remoteQueueTargetSize: fieldErrors.remoteQueueTargetSize?.[0],
      });
      return;
    }

    if (
      editingProviderId === null &&
      ttsSettings.providers.some((item) => item.id === parsed.data.id)
    ) {
      setProviderFormErrors({ id: _('Provider ID already exists') });
      return;
    }

    const normalizedProvider = toProviderProfile(parsed.data);
    if (!normalizedProvider) {
      setProviderFormErrors({
        _form: _('Invalid provider configuration'),
      });
      return;
    }

    const provider =
      editingProviderId === null
        ? {
            ...normalizedProvider,
            id: parsed.data.id,
          }
        : {
            ...normalizedProvider,
            id: editingProviderId,
            cachedVoices:
              ttsSettings.providers.find((item) => item.id === editingProviderId)?.cachedVoices ||
              normalizedProvider.cachedVoices,
          };

    const providers =
      editingProviderId === null
        ? [...ttsSettings.providers, provider]
        : ttsSettings.providers.map((item) => (item.id === editingProviderId ? provider : item));

    const activeProviderId =
      ttsSettings.activeProviderId &&
      providers.some((item) => item.id === ttsSettings.activeProviderId)
        ? ttsSettings.activeProviderId
        : providers[0]?.id || null;

    await persistTTSSettings({
      ...ttsSettings,
      providers,
      activeProviderId,
    });
    setProviderFormErrors({});
    resetProviderForm();
  };

  const handleDeleteProvider = async (providerId: string) => {
    const providers = ttsSettings.providers.filter((provider) => provider.id !== providerId);
    const activeProviderId =
      ttsSettings.activeProviderId === providerId
        ? providers[0]?.id || null
        : ttsSettings.activeProviderId;
    await persistTTSSettings({
      ...ttsSettings,
      providers,
      activeProviderId,
    });
    if (editingProviderId === providerId) {
      resetProviderForm();
    }
  };

  const handleEditProvider = (provider: TTSProviderProfile) => {
    setEditingProviderId(provider.id);
    setProviderFormErrors({});
    setProviderForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      defaultVoice: provider.defaultVoice,
      enabled: provider.enabled,
      timeoutMs: normalizeFormNumber(provider.timeoutMs, 30000),
      responseFormat: provider.responseFormat || 'mp3',
      stream: !!provider.stream,
      remoteChunkMaxSentences: normalizeFormNumber(
        provider.remoteChunkMaxSentences,
        DEFAULT_REMOTE_CHUNK_MAX_SENTENCES,
      ),
      remoteChunkTargetChars: normalizeFormNumber(
        provider.remoteChunkTargetChars,
        DEFAULT_REMOTE_CHUNK_TARGET_CHARS,
      ),
      remoteChunkHardLimitChars: normalizeFormNumber(
        provider.remoteChunkHardLimitChars,
        DEFAULT_REMOTE_CHUNK_HARD_LIMIT_CHARS,
      ),
      remoteQueueTargetSize: normalizeFormNumber(
        provider.remoteQueueTargetSize,
        DEFAULT_REMOTE_QUEUE_TARGET_SIZE,
      ),
    });
  };

  const handleActivateProvider = async (providerId: string) => {
    await persistTTSSettings({
      ...ttsSettings,
      activeProviderId: providerId,
    });
  };

  const handleTestProvider = async (provider: TTSProviderProfile) => {
    setHealthStatuses((prev) => ({ ...prev, [provider.id]: 'testing' }));
    setHealthMessages((prev) => ({ ...prev, [provider.id]: '' }));
    try {
      const adapter = getRemoteTTSAdapter(provider);
      const result = await adapter.health(provider);
      const voices = await adapter.listVoices(provider);
      const normalizedVoices = voices.map((voice) => ({
        id: voice.id,
        name: voice.name || voice.id,
        lang: voice.lang || 'en',
      }));
      const hasCurrentDefault = normalizedVoices.some(
        (voice) => voice.id === provider.defaultVoice,
      );
      const nextDefaultVoice =
        hasCurrentDefault || !normalizedVoices.length
          ? provider.defaultVoice
          : normalizedVoices[0]!.id;
      const providerUpdated =
        !hasCurrentDefault ||
        !provider.cachedVoices ||
        provider.cachedVoices.length !== normalizedVoices.length ||
        provider.cachedVoices.some(
          (voice, idx) =>
            voice.id !== normalizedVoices[idx]?.id ||
            voice.name !== normalizedVoices[idx]?.name ||
            voice.lang !== normalizedVoices[idx]?.lang,
        );

      if (providerUpdated || nextDefaultVoice !== provider.defaultVoice) {
        const providers = ttsSettings.providers.map((item) =>
          item.id === provider.id
            ? {
                ...item,
                cachedVoices: normalizedVoices,
                defaultVoice: nextDefaultVoice,
              }
            : item,
        );
        await persistTTSSettings({
          ...ttsSettings,
          providers,
        });
      }

      setHealthStatuses((prev) => ({ ...prev, [provider.id]: 'success' }));
      setHealthMessages((prev) => ({
        ...prev,
        [provider.id]:
          result?.latencyMs !== undefined
            ? `${_('Latency')}: ${result.latencyMs}ms · ${_('Voices')}: ${normalizedVoices.length}`
            : _('Connected'),
      }));
    } catch (error) {
      setHealthStatuses((prev) => ({ ...prev, [provider.id]: 'error' }));
      setHealthMessages((prev) => ({
        ...prev,
        [provider.id]:
          error instanceof RemoteTTSAdapterError
            ? error.message
            : error instanceof Error
              ? error.message
              : _('Connection failed'),
      }));
    }
  };

  return (
    <div className='my-4 w-full space-y-6'>
      <div className='w-full' data-setting-id='settings.tts.defaultEngine'>
        <h2 className='mb-2 font-medium'>{_('TTS Engine')}</h2>
        <div className='card border-base-200 bg-base-100 border shadow'>
          <div className='config-item'>
            <span>{_('Default Engine')}</span>
            <select
              className='select select-bordered select-sm max-w-xs'
              value={ttsSettings.defaultEngine}
              onChange={(e) => handleEngineChange(e.target.value as TTSEngineType)}
            >
              <option value='edge-tts'>Edge TTS</option>
              <option value='web-speech'>Web Speech</option>
              <option value='native-tts'>Native TTS</option>
              <option value='remote-tts'>Remote Provider</option>
            </select>
          </div>
        </div>
      </div>

      <div className='w-full' data-setting-id='settings.tts.providers'>
        <h2 className='mb-2 font-medium'>{_('Remote TTS Providers')}</h2>
        <div className='card border-base-200 bg-base-100 border shadow'>
          <div className='divide-base-200 divide-y'>
            {ttsSettings.providers.length === 0 ? (
              <div className='config-item text-base-content/60'>{_('No providers configured')}</div>
            ) : (
              ttsSettings.providers.map((provider) => (
                <div key={provider.id} className='p-3'>
                  <div className='flex flex-wrap items-start justify-between gap-2'>
                    <div className='min-w-0'>
                      <div className='truncate font-medium'>{provider.name}</div>
                      <div className='text-base-content/60 truncate text-xs'>
                        {provider.baseUrl}
                      </div>
                      <div className='text-base-content/50 text-[11px]'>
                        {`Format: ${(provider.responseFormat || 'mp3').toUpperCase()} · Stream: ${
                          provider.stream ? 'on' : 'off'
                        } · Chunk: ${provider.remoteChunkMaxSentences || DEFAULT_REMOTE_CHUNK_MAX_SENTENCES} sent / ${
                          provider.remoteChunkTargetChars || DEFAULT_REMOTE_CHUNK_TARGET_CHARS
                        } chars`}
                      </div>
                    </div>
                    <div className='flex shrink-0 flex-wrap items-center justify-end gap-2'>
                      <button
                        className='btn btn-xs whitespace-nowrap'
                        onClick={() => handleActivateProvider(provider.id)}
                        disabled={ttsSettings.activeProviderId === provider.id}
                      >
                        {ttsSettings.activeProviderId === provider.id ? _('Active') : _('Use')}
                      </button>
                      <button
                        className='btn btn-ghost btn-xs whitespace-nowrap'
                        onClick={() => handleEditProvider(provider)}
                      >
                        {_('Edit')}
                      </button>
                      <button
                        className='btn btn-ghost btn-xs whitespace-nowrap text-red-500'
                        onClick={() => handleDeleteProvider(provider.id)}
                      >
                        {_('Delete')}
                      </button>
                    </div>
                  </div>
                  <div className='mt-2 flex items-center gap-2'>
                    <button
                      className='btn btn-outline btn-xs'
                      onClick={() => handleTestProvider(provider)}
                      disabled={healthStatuses[provider.id] === 'testing'}
                    >
                      {healthStatuses[provider.id] === 'testing'
                        ? _('Testing...')
                        : _('Test Connection')}
                    </button>
                    {healthMessages[provider.id] && (
                      <span
                        className={`text-xs ${
                          healthStatuses[provider.id] === 'error'
                            ? 'text-red-500'
                            : 'text-green-600'
                        }`}
                      >
                        {healthMessages[provider.id]}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className='w-full' data-setting-id='settings.tts.providerEditor'>
        <h2 className='mb-2 font-medium'>
          {editingProviderId ? _('Edit Provider') : _('Add Provider')}
        </h2>
        <div className='card border-base-200 bg-base-100 border p-3 shadow'>
          {providerFormErrors._form && (
            <div className='mb-2 text-xs text-red-500'>{providerFormErrors._form}</div>
          )}
          <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
            <input
              className='input input-bordered input-sm'
              placeholder={_('Provider Name')}
              value={providerForm.name}
              onChange={(e) => {
                setProviderForm((prev) => ({ ...prev, name: e.target.value }));
                setProviderFormErrors((prev) => ({ ...prev, name: undefined, _form: undefined }));
              }}
            />
            {providerFormErrors.name && (
              <div className='text-xs text-red-500 sm:col-span-2'>{providerFormErrors.name}</div>
            )}
            <input
              className='input input-bordered input-sm'
              placeholder={_('Provider ID (optional)')}
              value={providerForm.id}
              onChange={(e) => {
                setProviderForm((prev) => ({ ...prev, id: e.target.value }));
                setProviderFormErrors((prev) => ({ ...prev, id: undefined, _form: undefined }));
              }}
            />
            {providerFormErrors.id && (
              <div className='text-xs text-red-500 sm:col-span-2'>{providerFormErrors.id}</div>
            )}
            <input
              className='input input-bordered input-sm sm:col-span-2'
              placeholder='https://api.example.com/v1'
              value={providerForm.baseUrl}
              onChange={(e) => {
                setProviderForm((prev) => ({ ...prev, baseUrl: e.target.value }));
                setProviderFormErrors((prev) => ({
                  ...prev,
                  baseUrl: undefined,
                  _form: undefined,
                }));
              }}
            />
            {providerFormErrors.baseUrl && (
              <div className='text-xs text-red-500 sm:col-span-2'>{providerFormErrors.baseUrl}</div>
            )}
            <input
              className='input input-bordered input-sm sm:col-span-2'
              type='password'
              placeholder={_('API Key')}
              value={providerForm.apiKey}
              onChange={(e) => {
                setProviderForm((prev) => ({ ...prev, apiKey: e.target.value }));
                setProviderFormErrors((prev) => ({ ...prev, apiKey: undefined, _form: undefined }));
              }}
            />
            <input
              className='input input-bordered input-sm'
              placeholder={_('Model')}
              value={providerForm.model}
              onChange={(e) => {
                setProviderForm((prev) => ({ ...prev, model: e.target.value }));
                setProviderFormErrors((prev) => ({ ...prev, model: undefined, _form: undefined }));
              }}
            />
            <input
              className='input input-bordered input-sm'
              placeholder={_('Default Voice')}
              value={providerForm.defaultVoice}
              onChange={(e) => {
                setProviderForm((prev) => ({ ...prev, defaultVoice: e.target.value }));
                setProviderFormErrors((prev) => ({
                  ...prev,
                  defaultVoice: undefined,
                  _form: undefined,
                }));
              }}
            />
            <input
              className='input input-bordered input-sm'
              type='number'
              min={1000}
              step={1000}
              placeholder={_('Timeout (ms)')}
              value={providerForm.timeoutMs}
              onChange={(e) => {
                setProviderForm((prev) => ({
                  ...prev,
                  timeoutMs: parseNumberInput(e.target.value, 30000),
                }));
                setProviderFormErrors((prev) => ({
                  ...prev,
                  timeoutMs: undefined,
                  _form: undefined,
                }));
              }}
            />
            {providerFormErrors.timeoutMs && (
              <div className='text-xs text-red-500 sm:col-span-2'>
                {providerFormErrors.timeoutMs}
              </div>
            )}
            <label className='label cursor-pointer justify-start gap-2'>
              <input
                type='checkbox'
                className='toggle toggle-sm'
                checked={providerForm.enabled}
                onChange={(e) =>
                  setProviderForm((prev) => ({ ...prev, enabled: e.target.checked }))
                }
              />
              <span>{_('Enabled')}</span>
            </label>
            <select
              className='select select-bordered select-sm'
              value={providerForm.responseFormat}
              onChange={(e) =>
                setProviderForm((prev) => ({
                  ...prev,
                  responseFormat: e.target.value as TTSAudioFormat,
                }))
              }
            >
              <option value='mp3'>MP3</option>
              <option value='wav'>WAV</option>
            </select>
            <label className='label cursor-pointer justify-start gap-2'>
              <input
                type='checkbox'
                className='toggle toggle-sm'
                checked={providerForm.stream}
                onChange={(e) => {
                  setProviderForm((prev) => ({ ...prev, stream: e.target.checked }));
                  setProviderFormErrors((prev) => ({ ...prev, _form: undefined }));
                }}
              />
              <span>{_('Stream mode')}</span>
            </label>
            <div className='sm:col-span-2'>
              <div className='text-base-content/70 mb-1 text-xs'>{_('Remote chunk tuning')}</div>
              <div className='grid grid-cols-1 gap-2 md:grid-cols-2'>
                <input
                  className='input input-bordered input-sm w-full min-w-0'
                  type='number'
                  min={1}
                  max={8}
                  step={1}
                  placeholder={_('Chunk max sentences')}
                  value={providerForm.remoteChunkMaxSentences}
                  onChange={(e) => {
                    setProviderForm((prev) => ({
                      ...prev,
                      remoteChunkMaxSentences: parseNumberInput(
                        e.target.value,
                        DEFAULT_REMOTE_CHUNK_MAX_SENTENCES,
                      ),
                    }));
                    setProviderFormErrors((prev) => ({
                      ...prev,
                      remoteChunkMaxSentences: undefined,
                      _form: undefined,
                    }));
                  }}
                />
                <input
                  className='input input-bordered input-sm w-full min-w-0'
                  type='number'
                  min={40}
                  max={400}
                  step={10}
                  placeholder={_('Chunk target chars')}
                  value={providerForm.remoteChunkTargetChars}
                  onChange={(e) => {
                    setProviderForm((prev) => ({
                      ...prev,
                      remoteChunkTargetChars: parseNumberInput(
                        e.target.value,
                        DEFAULT_REMOTE_CHUNK_TARGET_CHARS,
                      ),
                    }));
                    setProviderFormErrors((prev) => ({
                      ...prev,
                      remoteChunkTargetChars: undefined,
                      _form: undefined,
                    }));
                  }}
                />
                <input
                  className='input input-bordered input-sm w-full min-w-0'
                  type='number'
                  min={60}
                  max={600}
                  step={10}
                  placeholder={_('Chunk hard limit chars')}
                  value={providerForm.remoteChunkHardLimitChars}
                  onChange={(e) => {
                    setProviderForm((prev) => ({
                      ...prev,
                      remoteChunkHardLimitChars: parseNumberInput(
                        e.target.value,
                        DEFAULT_REMOTE_CHUNK_HARD_LIMIT_CHARS,
                      ),
                    }));
                    setProviderFormErrors((prev) => ({
                      ...prev,
                      remoteChunkHardLimitChars: undefined,
                      _form: undefined,
                    }));
                  }}
                />
                <input
                  className='input input-bordered input-sm w-full min-w-0'
                  type='number'
                  min={1}
                  max={8}
                  step={1}
                  placeholder={_('Queue size')}
                  value={providerForm.remoteQueueTargetSize}
                  onChange={(e) => {
                    setProviderForm((prev) => ({
                      ...prev,
                      remoteQueueTargetSize: parseNumberInput(
                        e.target.value,
                        DEFAULT_REMOTE_QUEUE_TARGET_SIZE,
                      ),
                    }));
                    setProviderFormErrors((prev) => ({
                      ...prev,
                      remoteQueueTargetSize: undefined,
                      _form: undefined,
                    }));
                  }}
                />
              </div>
            </div>
            {providerFormErrors.remoteChunkMaxSentences && (
              <div className='text-xs text-red-500 sm:col-span-2'>
                {providerFormErrors.remoteChunkMaxSentences}
              </div>
            )}
            {providerFormErrors.remoteChunkTargetChars && (
              <div className='text-xs text-red-500 sm:col-span-2'>
                {providerFormErrors.remoteChunkTargetChars}
              </div>
            )}
            {providerFormErrors.remoteChunkHardLimitChars && (
              <div className='text-xs text-red-500 sm:col-span-2'>
                {providerFormErrors.remoteChunkHardLimitChars}
              </div>
            )}
            {providerFormErrors.remoteQueueTargetSize && (
              <div className='text-xs text-red-500 sm:col-span-2'>
                {providerFormErrors.remoteQueueTargetSize}
              </div>
            )}
          </div>
          <div className='mt-3 flex gap-2'>
            <button className='btn btn-primary btn-sm' onClick={handleSaveProvider}>
              {editingProviderId ? _('Update Provider') : _('Add Provider')}
            </button>
            {editingProviderId && (
              <button className='btn btn-ghost btn-sm' onClick={resetProviderForm}>
                {_('Cancel')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TTSSettingsPanel;
