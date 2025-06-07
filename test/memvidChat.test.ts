import { MemvidChat } from '../src/memvidChat';
import { MemvidRetriever } from '../src/retriever';
import { LlmClient, ChatMessage, ChatStreamDelta, SupportedProviders } from '../src/llmClient';
import { getDefaultConfig, MemvidConfig } from '../src/config';

// Mocking the dependencies
jest.mock('../src/retriever');
jest.mock('../src/llmClient');

// Helper type for mocked class instances
type MockedClass<T> = jest.Mocked<T> & { mockClear: () => void };


describe('MemvidChat', () => {
  let mockRetriever: MockedClass<MemvidRetriever>;
  let mockLlmClient: MockedClass<LlmClient>;
  let chatInstance: MemvidChat;
  let config: MemvidConfig;

  beforeEach(() => {
    config = getDefaultConfig(); // Get fresh config for each test

    // Clear previous mocks and create new instances
    // Note: jest.Mocked<T> casts are for type safety with mocked instances
    // The actual constructor for MemvidRetriever takes (videoSource, indexFile, config)
    // For mocking, we might not need all, but let's provide basic valid args.
    // We need to ensure the mock constructor is being captured by jest.mock

    // If MemvidRetriever's constructor does heavy lifting or async work not needed for mock:
    // MemvidRetriever.prototype.constructor = jest.fn().mockImplementation(() => ({})) as any;
    // Or ensure the mocked class has a simple constructor.
    // For this test, we assume the mock from jest.mock('../src/retriever') is sufficient.

    mockRetriever = new (MemvidRetriever as any)(new Uint8Array(0), 'dummy_index_path.hnsw', config) as MockedClass<MemvidRetriever>;
    mockLlmClient = new (LlmClient as any)('openai' as SupportedProviders, config, 'fake-api-key') as MockedClass<LlmClient>;

    // Explicitly mock methods on the instances
    mockRetriever.search = jest.fn();
    // Retriever's readyPromise needs to resolve for chat to proceed
    mockRetriever.readyPromise = Promise.resolve(undefined);

    mockLlmClient.chat = jest.fn();
    mockLlmClient.chatStream = jest.fn(
      async (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }) =>
        (async function* () {
          yield { role: 'assistant' as const, content: 'streamed response' };
        })()
    );


    // Re-initialize chatInstance for each test
    chatInstance = new MemvidChat(mockRetriever, config, mockLlmClient);
    chatInstance.startSession(); // Start a default session
  });

  it('should retrieve context and build messages for LLM, then call LLM chat', async () => {
    const userMessage = 'test message about video';
    const mockContextChunks = ['context chunk 1 from video', 'context chunk 2'];
    // Retriever's search method is expected to return string[] based on MemvidChat's getContext
    mockRetriever.search.mockResolvedValueOnce(mockContextChunks);

    const llmResponse: ChatMessage = { role: 'assistant', content: 'LLM response based on context' };
    mockLlmClient.chat.mockResolvedValueOnce(llmResponse);

    await chatInstance.chat(userMessage);

    expect(mockRetriever.search).toHaveBeenCalledWith(userMessage, config.chat!.contextChunksPerQuery);

    expect(mockLlmClient.chat).toHaveBeenCalled();
    const messagesSentToLlm = mockLlmClient.chat.mock.calls[0][0] as ChatMessage[];

    expect(messagesSentToLlm[0].role).toBe('system');
    expect(messagesSentToLlm[0].content).toBe(config.chat!.systemPrompt);
    // Second to last message should be user message with context
    const userMessageWithContext = messagesSentToLlm[messagesSentToLlm.length -1];
    expect(userMessageWithContext.role).toBe('user');
    expect(userMessageWithContext.content).toContain('Context from video:\n' + mockContextChunks.join('\n\n'));
    expect(userMessageWithContext.content).toContain(`User Question: ${userMessage}`);
  });

  it('should handle chat history correctly', async () => {
    config.chat!.maxHistoryLength = 2; // 1 user, 1 assistant message
    // Need to re-initialize with this specific config for maxHistoryLength
    chatInstance = new MemvidChat(mockRetriever, config, mockLlmClient);
    chatInstance.startSession();


    mockRetriever.search.mockResolvedValue([]); // No context for simplicity here
    mockLlmClient.chat
      .mockResolvedValueOnce({ role: 'assistant', content: 'response 1' })
      .mockResolvedValueOnce({ role: 'assistant', content: 'response 2' });

    await chatInstance.chat('message 1'); // User: msg1, AI: resp1
    await chatInstance.chat('message 2'); // User: msg2, AI: resp2

    // Check history for the call to 'message 2'
    const messagesForMsg2 = mockLlmClient.chat.mock.calls[1][0] as ChatMessage[];
    // Expected: System, User:msg1, Assistant:resp1, User:msg2 (with context)
    // But history is capped at 2 (1 pair). So for 2nd call, history should be User:msg1, Assistant:resp1
    // System prompt is always first. Then history. Then current user message.
    // So, messagesForMsg2[1] should be user:msg1, messagesForMsg2[2] should be assistant:resp1

    // History for 2nd LLM call: User: msg1, Assistant: resp1
    // System Prompt is at messagesForMsg2[0]
    expect(messagesForMsg2.filter(m => m.role !== 'system' && m.role !== 'user').length).toBe(1); // One assistant message in history
    expect(messagesForMsg2.find(m => m.role === 'user' && m.content.includes('message 1'))).toBeDefined();
    expect(messagesForMsg2.find(m => m.role === 'assistant' && m.content === 'response 1')).toBeDefined();
    // Since context is empty, the user message should be plain
    expect(messagesForMsg2[messagesForMsg2.length -1].content).toBe('message 2');


    // Third message, history should now be User:msg2, Assistant:resp2
    mockLlmClient.chat.mockResolvedValueOnce({ role: 'assistant', content: 'response 3' });
    await chatInstance.chat('message 3');
    const messagesForMsg3 = mockLlmClient.chat.mock.calls[2][0] as ChatMessage[];
    expect(messagesForMsg3.find(m => m.role === 'user' && m.content.includes('message 2'))).toBeDefined();
    expect(messagesForMsg3.find(m => m.role === 'assistant' && m.content === 'response 2')).toBeDefined();
    // Since context is still empty, the user message should be plain
    expect(messagesForMsg3[messagesForMsg3.length -1].content).toBe('message 3');
  });

  it('should work in context-only mode if LLM client is not provided', async () => {
    const chatInstanceNoLlm = new MemvidChat(mockRetriever, config, undefined); // No LLM client
    chatInstanceNoLlm.startSession();

    const mockContext = ['context for retrieval only'];
    mockRetriever.search.mockResolvedValueOnce(mockContext);

    const response = await chatInstanceNoLlm.chat('query for context') as string;

    expect(mockRetriever.search).toHaveBeenCalledWith('query for context', config.chat!.contextChunksPerQuery);
    expect(response).toContain(mockContext.join('\n\n'));
    expect(mockLlmClient.chat).not.toHaveBeenCalled(); // Ensure LLM was not called
  });

  it('should handle streaming responses and update history correctly', async () => {
    const userMessage = 'test stream message';
    const streamChunks: ChatStreamDelta[] = [
      { content: 'hello ' },
      { content: 'world' },
      { content: '!', isFinal: true },
    ];

    // Mock the async generator
    mockLlmClient.chatStream.mockImplementationOnce(
      async (_messages: ChatMessage[], _options?: { temperature?: number; maxTokens?: number }) =>
        (async function* () {
          for (const chunk of streamChunks) {
            yield chunk;
          }
        })()
    );
    mockRetriever.search.mockResolvedValueOnce([]); // No context for simplicity

    const stream = await chatInstance.chat(userMessage, true) as AsyncGenerator<ChatStreamDelta, void, undefined>;

    const receivedChunks: ChatStreamDelta[] = [];
    let fullTextResponse = "";

    for await (const delta of stream) {
      receivedChunks.push(delta);
      if(delta.content) fullTextResponse += delta.content;
    }

    expect(receivedChunks.length).toBe(streamChunks.length);
    expect(fullTextResponse).toBe('hello world!');

    // Check history
    const history = chatInstance.getHistory();
    expect(history.length).toBe(2); // User message + full assistant response
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe(userMessage);
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('hello world!');
  });

  it('should clear history', async () => {
    mockRetriever.search.mockResolvedValueOnce([]);
    mockLlmClient.chat.mockResolvedValueOnce({ role: 'assistant', content: 'response 1' });
    await chatInstance.chat('message 1');
    expect(chatInstance.getHistory().length).toBe(2);
    chatInstance.clearHistory();
    expect(chatInstance.getHistory().length).toBe(0);
  });
});
