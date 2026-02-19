import { TTSProviderProfile } from '@/types/settings';
import { REMOTE_TTS_ERROR_CODES } from '@/services/tts/providerSettings';
import { RemoteTTSAdapter, RemoteTTSAdapterError } from './adapter';
import { OpenAICompatibleAdapter } from './openaiCompatibleAdapter';

export const getRemoteTTSAdapter = (provider: TTSProviderProfile): RemoteTTSAdapter => {
  if (provider.type === 'openai_compatible') {
    return new OpenAICompatibleAdapter();
  }

  throw new RemoteTTSAdapterError(
    REMOTE_TTS_ERROR_CODES.InvalidProvider,
    `Unsupported provider type: ${provider.type}`,
    400,
  );
};
