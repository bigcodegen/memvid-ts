import { LlmClient, ChatMessage, ChatStreamDelta, SupportedProviders } from './llmClient.js';
import { MemvidRetriever } from './retriever.js';
import { MemvidConfig, getDefaultConfig } from './config.js';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const logger = {
  info: (message: string) => console.log(`[INFO][MemvidChat] ${message}`),
  warn: (message: string) => console.warn(`[WARN][MemvidChat] ${message}`),
  error: (message: string) => console.error(`[ERROR][MemvidChat] ${message}`),
};

export class MemvidChat {
  private retriever: MemvidRetriever;
  private config: MemvidConfig;
  private llmClient?: LlmClient;
  private conversationHistory: ChatMessage[] = [];
  private currentSessionId?: string;
  private systemPrompt: string;

  // Chat specific config values with defaults
  private contextChunksPerQuery: number;
  private maxHistoryLength: number;
  private maxContextTokens: number;
  private llmResponseMaxTokens: number;


  constructor(
    retriever: MemvidRetriever,
    config?: Partial<MemvidConfig>, // Allow partial config override
    llmClient?: LlmClient
  ) {
    this.retriever = retriever;
    const baseConfig = getDefaultConfig();
    // Deep merge config, especially for nested chat and llm objects
    this.config = {
        ...baseConfig,
        ...config,
        llm: { ...baseConfig.llm, ...(config?.llm || {}) } as Required<MemvidConfig['llm']>, // Ensure llm is defined
        chat: { ...baseConfig.chat, ...(config?.chat || {}) } as Required<MemvidConfig['chat']>, // Ensure chat is defined
    };

    this.llmClient = llmClient;
    this.systemPrompt = this.config.chat!.systemPrompt || this.getDefaultSystemPrompt();
    this.contextChunksPerQuery = this.config.chat!.contextChunksPerQuery!;
    this.maxHistoryLength = this.config.chat!.maxHistoryLength!;
    this.maxContextTokens = this.config.llm!.maxContextTokensForContext!;
    this.llmResponseMaxTokens = this.config.llm!.maxTokens!;

    logger.info("MemvidChat initialized.");
    if (!this.llmClient) {
        logger.warn("LlmClient not provided. Chat will operate in retrieval-only mode.");
    }
  }

  private getDefaultSystemPrompt(): string {
    return "You are a helpful AI assistant. Use the provided context to answer questions about a video. If the context doesn't contain the answer, say you don't know.";
  }

  public startSession(systemPrompt?: string, sessionId?: string): void {
    this.clearHistory();
    this.systemPrompt = systemPrompt || this.config.chat!.systemPrompt || this.getDefaultSystemPrompt();
    this.currentSessionId = sessionId || `session_${Date.now()}`;
    logger.info(`Chat session started. ID: ${this.currentSessionId}. System Prompt: "${this.systemPrompt}"`);
  }

  private async getContext(query: string): Promise<string> {
    logger.info(`Retrieving context for query: "${query.substring(0, 50)}..."`);
    // Assuming retriever.search returns an array of strings (text chunks)
    // In previous versions, retriever.search returns string[]. If it's SearchResult[], adapt this.
    // Based on retriever.ts (WASM version), search returns string[] of chunk texts.
    const contextChunks = await this.retriever.search(query, this.contextChunksPerQuery);

    if (!contextChunks || contextChunks.length === 0) {
      logger.info("No context chunks found for the query.");
      return "";
    }

    // Simple concatenation, respecting maxContextTokens (approximate by length)
    let combinedContext = "";
    for (const chunk of contextChunks) {
      if ((combinedContext + chunk).length > this.maxContextTokens) {
        logger.warn(`Context truncated due to maxContextTokens limit (${this.maxContextTokens}).`);
        break;
      }
      combinedContext += chunk + "\n\n";
    }
    logger.info(`Context retrieved. Length: ${combinedContext.length} chars.`);
    return combinedContext.trim();
  }

  public clearHistory(): void {
    this.conversationHistory = [];
    logger.info("Conversation history cleared.");
  }

  public async chat(message: string): Promise<string> {
    // Retrieval-only mode: get context and return as response
    const context = await this.getContext(message);
    if (context) {
      return `Context from video:\n${context}`;
    } else {
      return "No relevant context found in the video for your query.";
    }
  }
}