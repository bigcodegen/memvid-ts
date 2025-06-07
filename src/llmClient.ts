import OpenAI from 'openai';
import { MemvidConfig } from './config.js'; // To access defaultModels and apiKeyEnvVars

// 1. INTERFACES (camelCase)
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'; // System role might need mapping for some providers
  content: string;
}

export interface ChatStreamDelta {
  role?: 'assistant'; // Typically, only assistant messages are streamed back
  content?: string | null; // Content can be partial
  isFinal?: boolean; // Indicates if this is the last part of the message
  error?: string; // If an error occurred during streaming
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<ChatMessage>;
  chatStream(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): AsyncGenerator<ChatStreamDelta, void, undefined>;
}


// 2. OpenAI PROVIDER
class OpenAiProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<ChatMessage> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any[], // OpenAI type is slightly different but compatible for role/content
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
    });
    const choice = response.choices[0];
    return {
      role: choice.message.role === 'assistant' ? 'assistant' : 'user', // Simplify role
      content: choice.message.content || '',
    };
  }

  async *chatStream(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): AsyncGenerator<ChatStreamDelta, void, undefined> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any[],
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      yield {
        role: delta?.role === 'assistant' ? 'assistant' : undefined,
        content: delta?.content,
        isFinal: chunk.choices[0]?.finish_reason === 'stop',
      };
      if (chunk.choices[0]?.finish_reason === 'stop') break;
    }
  }
}

// 5. LLMCLIENT WRAPPER
export type SupportedProviders = 'openai';

export class LlmClient {
  private provider: LLMProvider;

  constructor(
    providerName: SupportedProviders,
    config: MemvidConfig, // Pass the whole config object
    apiKey?: string, // Optional API key, overrides env var
    model?: string   // Optional model, overrides default for the provider
  ) {
    const { llm } = config;
    if (!llm) {
      throw new Error('LLM configuration is missing from MemvidConfig.');
    }
    const llmConfig = llm as { defaultModels: { openai: string; google: string; anthropic: string; }, apiKeyEnvVars: { openai: string; google: string; anthropic: string; } };
    const chosenApiKey = apiKey || this.getApiKeyFromEnv(providerName, llmConfig.apiKeyEnvVars);
    if (!chosenApiKey) {
      throw new Error(`API key for ${providerName} not found. Provide it directly or set ${llmConfig.apiKeyEnvVars[providerName]}.`);
    }

    const chosenModel = model || llmConfig.defaultModels[providerName];

    switch (providerName) {
      case 'openai':
        this.provider = new OpenAiProvider(chosenApiKey, chosenModel);
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${providerName}`);
    }
  }

  private getApiKeyFromEnv(providerName: SupportedProviders, envVarMap: MemvidConfig['llm']['apiKeyEnvVars']): string | undefined {
    if (!envVarMap) return undefined;
    if (typeof process !== 'undefined' && process.env) {
      const envVarName = envVarMap[providerName];
      return process.env[envVarName];
    }
    return undefined;
  }

  async chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<ChatMessage> {
    return this.provider.chat(messages, options);
  }

  async chatStream(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<AsyncGenerator<ChatStreamDelta, void, undefined>> {
    return this.provider.chatStream(messages, options);
  }
}
