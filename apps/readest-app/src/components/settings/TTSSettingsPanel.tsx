import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useEnv } from '@/context/EnvContext';
import { SettingsPanelPanelProp } from './SettingsDialog';
import {
  DEFAULT_TTS_SETTINGS,
  normalizeTTSProviderProfile,
  normalizeTTSSettings,
} from '@/services/tts/providerSettings';
import { TTSAudioFormat, TTSProviderProfile, TTSEngineType, TTSSettings } from '@/types/settings';
import { fetchWithAuth } from '@/utils/fetch';

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
};

const createProviderForm = (): ProviderForm => ({
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  model: 'gpt-4o-mini-tts',
  defaultVoice: 'alloy',
  enabled: true,
  timeoutMs: 30000,
  responseFormat: 'mp3',
  stream: false,
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
  const [healthStatuses, setHealthStatuses] = useState<Record<string, HealthStatus>>({});
  const [healthMessages, setHealthMessages] = useState<Record<string, string>>({});

  const persistTTSSettings = async (nextTTSSettings: TTSSettings) => {
    const nextSettings = { ...settings, ttsSettings: normalizeTTSSettings(nextTTSSettings) };
    setSettings(nextSettings);
    await saveSettings(envConfig, nextSettings);
  };

  const handleReset = () => {
    persistTTSSettings(DEFAULT_TTS_SETTINGS);
    setProviderForm(createProviderForm());
    setEditingProviderId(null);
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
  };

  const handleSaveProvider = async () => {
    const normalizedProvider = toProviderProfile(providerForm);
    if (!normalizedProvider) return;

    const provider =
      editingProviderId === null
        ? {
            ...normalizedProvider,
            id: normalizedProvider.id || createProviderId(),
          }
        : {
            ...normalizedProvider,
            id: editingProviderId,
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
    setProviderForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      defaultVoice: provider.defaultVoice,
      enabled: provider.enabled,
      timeoutMs: provider.timeoutMs || 30000,
      responseFormat: provider.responseFormat || 'mp3',
      stream: !!provider.stream,
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
      const response = await fetchWithAuth('/api/tts/remote/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const payload = await response.json();
      setHealthStatuses((prev) => ({ ...prev, [provider.id]: 'success' }));
      setHealthMessages((prev) => ({
        ...prev,
        [provider.id]:
          payload?.result?.latencyMs !== undefined
            ? `${_('Latency')}: ${payload.result.latencyMs}ms`
            : _('Connected'),
      }));
    } catch (error) {
      setHealthStatuses((prev) => ({ ...prev, [provider.id]: 'error' }));
      setHealthMessages((prev) => ({
        ...prev,
        [provider.id]: error instanceof Error ? error.message : _('Connection failed'),
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
                  <div className='flex items-center justify-between gap-2'>
                    <div className='min-w-0'>
                      <div className='truncate font-medium'>{provider.name}</div>
                      <div className='text-base-content/60 truncate text-xs'>
                        {provider.baseUrl}
                      </div>
                      <div className='text-base-content/50 text-[11px]'>
                        {`Format: ${(provider.responseFormat || 'mp3').toUpperCase()} · Stream: ${
                          provider.stream ? 'on' : 'off'
                        }`}
                      </div>
                    </div>
                    <div className='flex items-center gap-2'>
                      <button
                        className='btn btn-xs'
                        onClick={() => handleActivateProvider(provider.id)}
                        disabled={ttsSettings.activeProviderId === provider.id}
                      >
                        {ttsSettings.activeProviderId === provider.id ? _('Active') : _('Use')}
                      </button>
                      <button
                        className='btn btn-ghost btn-xs'
                        onClick={() => handleEditProvider(provider)}
                      >
                        {_('Edit')}
                      </button>
                      <button
                        className='btn btn-ghost btn-xs text-red-500'
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
          <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
            <input
              className='input input-bordered input-sm'
              placeholder={_('Provider Name')}
              value={providerForm.name}
              onChange={(e) => setProviderForm((prev) => ({ ...prev, name: e.target.value }))}
            />
            <input
              className='input input-bordered input-sm'
              placeholder={_('Provider ID (optional)')}
              value={providerForm.id}
              onChange={(e) => setProviderForm((prev) => ({ ...prev, id: e.target.value }))}
            />
            <input
              className='input input-bordered input-sm sm:col-span-2'
              placeholder='https://api.example.com/v1'
              value={providerForm.baseUrl}
              onChange={(e) => setProviderForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
            />
            <input
              className='input input-bordered input-sm sm:col-span-2'
              type='password'
              placeholder={_('API Key')}
              value={providerForm.apiKey}
              onChange={(e) => setProviderForm((prev) => ({ ...prev, apiKey: e.target.value }))}
            />
            <input
              className='input input-bordered input-sm'
              placeholder={_('Model')}
              value={providerForm.model}
              onChange={(e) => setProviderForm((prev) => ({ ...prev, model: e.target.value }))}
            />
            <input
              className='input input-bordered input-sm'
              placeholder={_('Default Voice')}
              value={providerForm.defaultVoice}
              onChange={(e) =>
                setProviderForm((prev) => ({ ...prev, defaultVoice: e.target.value }))
              }
            />
            <input
              className='input input-bordered input-sm'
              type='number'
              min={1000}
              step={1000}
              placeholder={_('Timeout (ms)')}
              value={providerForm.timeoutMs}
              onChange={(e) =>
                setProviderForm((prev) => ({ ...prev, timeoutMs: Number(e.target.value) || 30000 }))
              }
            />
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
                onChange={(e) => setProviderForm((prev) => ({ ...prev, stream: e.target.checked }))}
              />
              <span>{_('Stream mode')}</span>
            </label>
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
