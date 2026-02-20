import {
  AIProviderAdapter,
  AIProviderError,
  AIRequestOptions,
  AIProviderResponse,
} from '../types';

const HF_ROUTER_BASE = 'https://router.huggingface.co/v1';
const DEFAULT_TEXT_MODEL = 'mistralai/Mistral-7B-Instruct-v0.2';
const DEFAULT_TIMEOUT_MS = 12_000;

interface HuggingFaceEnv {
  HUGGINGFACE_API_KEY?: string;
  HUGGINGFACE_TEXT_MODEL?: string;
  HUGGINGFACE_IMAGE_MODEL?: string;
}

type JsonRecord = Record<string, unknown>;

const classifyError = (status: number | undefined, message: string) => {
  const lower = message.toLowerCase();
  if (status === 400) return { code: 'invalid_input' as const, retryable: false };
  if (status === 401 || status === 403) return { code: 'authentication' as const, retryable: false };
  if (status === 429) return { code: 'rate_limited' as const, retryable: true };
  if (status === 404) return { code: 'provider_unavailable' as const, retryable: true };
  if (status === 503 || lower.includes('loading')) return { code: 'provider_unavailable' as const, retryable: true };
  if (status !== undefined && status >= 500) return { code: 'server_error' as const, retryable: true };
  return { code: 'unknown' as const, retryable: false };
};

const resolveChatCompletionText = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as JsonRecord;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  if (choices.length === 0) return '';

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object') return '';
  const firstRecord = firstChoice as JsonRecord;
  const message = firstRecord.message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as JsonRecord).content;
  if (typeof content === 'string') return content;
  return '';
};

const makeTimeoutMs = (options: Required<AIRequestOptions>): number => {
  if (options.timeoutMs > 0) return options.timeoutMs;
  return DEFAULT_TIMEOUT_MS;
};

export const huggingFaceProvider: AIProviderAdapter<HuggingFaceEnv> = {
  provider: 'huggingface',
  generate: async (
    env: HuggingFaceEnv,
    prompt: string,
    options: Required<AIRequestOptions>,
    requestId: string
  ): Promise<AIProviderResponse> => {
    const apiKey = env.HUGGINGFACE_API_KEY;
    if (!apiKey) {
      throw new AIProviderError({
        provider: 'huggingface',
        code: 'authentication',
        retryable: false,
        message: 'Server missing HUGGINGFACE_API_KEY',
      });
    }

    const task = options.task;
    if (options.parts.length > 0) {
      throw new AIProviderError({
        provider: 'huggingface',
        code: 'invalid_input',
        retryable: false,
        message: 'Hugging Face fallback does not support inline multimodal parts in this gateway',
      });
    }

    if (task === 'image') {
      // Image fallback is handled by Wikimedia in the application layer.
      throw new AIProviderError({
        provider: 'huggingface',
        code: 'provider_unavailable',
        retryable: true,
        message: 'Hugging Face image fallback is disabled for this gateway',
      });
    }

    const model = options.huggingFaceModel || env.HUGGINGFACE_TEXT_MODEL || DEFAULT_TEXT_MODEL;
    const timeoutMs = makeTimeoutMs(options);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const body: JsonRecord = {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxTokens,
        temperature: options.temperature,
      };

      if (task === 'json') {
        body.response_format = { type: 'json_object' };
      }

      const response = await fetch(`${HF_ROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          (payload as JsonRecord).error && typeof (payload as JsonRecord).error === 'string'
            ? String((payload as JsonRecord).error)
            : `Hugging Face request failed (${response.status})`;
        const classified = classifyError(response.status, message);

        throw new AIProviderError({
          provider: 'huggingface',
          code: classified.code,
          retryable: classified.retryable,
          status: response.status,
          message,
        });
      }

      const text = resolveChatCompletionText(payload).trim();
      if (!text) {
        throw new AIProviderError({
          provider: 'huggingface',
          code: 'provider_unavailable',
          retryable: true,
          message: 'Hugging Face returned empty output',
        });
      }

      return { text, latencyMs };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new AIProviderError({
          provider: 'huggingface',
          code: 'timeout',
          retryable: true,
          message: `Hugging Face timed out after ${timeoutMs}ms`,
        });
      }

      throw new AIProviderError({
        provider: 'huggingface',
        code: 'network_error',
        retryable: true,
        message: error instanceof Error ? error.message : 'Hugging Face request failed',
      });
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
