# Memvid - Video-Based AI Memory (TypeScript/Node.js Version) 🧠📹

**A lightweight, WASM-powered solution for AI memory at scale, now primarily in TypeScript.**

[npm version badge] [Node.js version badge]
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Memvid revolutionizes AI memory management by encoding text data into videos. This new TypeScript version leverages **WebAssembly (WASM)** for core functionalities like video processing and vector indexing, enabling **lightning-fast semantic search** across millions of text chunks with **sub-second retrieval times**, and broader compatibility including modern browsers. Unlike traditional vector databases that can consume massive amounts of RAM, Memvid aims to compress your knowledge base into compact video files while maintaining instant access.

## 🎥 Demo (Conceptual)

*(The original demo showed the Python version. A new demo for the TS/WASM version would be similar in concept: encoding text to video, then performing semantic search and chat.)*
A new demo video showcasing the TypeScript/WASM version is pending.

## ✨ Key Features

- 🎥 **Video-as-Database**: Store text chunks by encoding them into QR codes within video frames.
- 🔍 **Semantic Search**: Find relevant content using natural language queries via vector embeddings.
- 💬 **Built-in Chat**: Conversational interface with context-aware responses (powered by LLMs).
- 📚 **Document Parsing**: Direct import and indexing of text from PDF and EPUB documents.
- 🚀 **Fast Retrieval**: Aims for sub-second search across datasets using WASM-powered indexing (HNSWlib).
- 💾 **Efficient Storage**: Text data is embedded in video; original text can be large but QR codes hold compressed data.
- 🔌 **Pluggable LLMs**: Supports OpenAI, Google, and Anthropic models via a unified client.
- 🌐 **Browser & Node.js**: Core WASM components enable usage in both Node.js and browser environments.
- 🔧 **Modern TypeScript API**: Clean, typed API for integration.
- **Minimal Dependencies (for core)**: Leverages powerful WASM libraries (`@ffmpeg/ffmpeg`, `hnswlib-wasm`) and TypeScript.

## 🎯 Use Cases

- **📖 Digital Content Archives**: Index articles, blog posts, or books in a compact format.
- **🎓 Educational Content**: Create searchable video memories of course materials.
- **💼 Corporate Knowledge**: Build searchable knowledge bases from internal documents.
- **🔬 Research Papers**: Quick semantic search across scientific literature.
- **📝 Personal Notes**: Transform your notes into a searchable AI assistant, accessible in more environments.

## 🚀 Why Memvid (TypeScript/WASM Version)?

### Innovation with WebAssembly
- **Video as Database**: Text chunks encoded as QR frames in a video.
- **Fast Retrieval**: WASM-accelerated HNSWlib for efficient similarity search.
- **Potential for Browser-Side Power**: Enables client-side processing, reducing server load for certain tasks.
- **Portability**: Video files and index files can be managed easily.

### Modern Architecture
- **TypeScript First**: Strong typing and modern JavaScript features.
- **Modular Design**: Separated components for encoding, retrieval, LLM interaction, and chat.
- **WASM Core**: Critical processing (video, indexing) uses WebAssembly for performance and portability.

## 📦 Installation

```bash
npm install memvid-ts # Placeholder package name, adjust if different
```
**Prerequisites:**
- Node.js (e.g., v18 or later recommended)
- For video processing with `@ffmpeg/ffmpeg`, ensure your environment can run WASM. FFmpeg itself is not needed as a separate system install if using the WASM version.

## 🎯 Quick Start

```typescript
import { MemvidEncoder, MemvidChat, MemvidRetriever, getDefaultConfig } from './src'; // Adjust path for your project structure
import { promises as fs } from 'fs'; // For saving files in this Node.js example

async function main() {
  const config = getDefaultConfig();
  // Configure for a smaller test video
  config.codecParameters.h264Wasm = { // Assuming h264Wasm is a valid key after config updates
    ...(config.codecParameters.h264Wasm || {}), // Spread existing or empty if not present
    frameHeight: 240,
    frameWidth: 320,
    videoFps: 10, // Lower FPS for quicker test encoding
  };
  config.codec = "h264Wasm"; // Ensure this codec is selected

  // Ensure an index path is set if using default HNSW config path
  config.index.path = config.index.path || 'memvid_index_ts';


  const encoder = new MemvidEncoder(config);
  encoder.addText("This is a test chunk for the new TypeScript Memvid.");
  encoder.addText("It uses WASM for encoding and HNSW for indexing.");
  encoder.addText("The third chunk provides a bit more information for context retrieval.");

  console.log("Building video and index with WASM...");
  // buildVideo now returns buffers
  const { videoBuffer, indexDataBuffer } = await encoder.buildVideo("memory_ts.mp4");

  // Example: Save video and index to disk in Node.js
  await fs.writeFile("memory_ts.mp4", videoBuffer);
  console.log("Video memory_ts.mp4 built and saved.");

  if (indexDataBuffer) {
    // In the new setup, HNSWIndexManager.save writes to disk using config.index.path.
    // The serializeIndex() method returns a buffer. If buildVideo uses serializeIndex,
    // we need to save it manually. If buildVideo calls index.save(), it's already saved.
    // The refactored buildVideo returns indexDataBuffer from serializeIndex().
    const indexFilePath = (config.index.path || 'memvid_index_ts') + '.hnsw'; // Construct expected path
    const metaFilePath = (config.index.path || 'memvid_index_ts') + '.meta.json';
    await fs.writeFile(indexFilePath, indexDataBuffer);
    // Note: HNSWIndexManager.save also saves metadata. Here we only have the index buffer.
    // For a complete load, metadata would also be needed.
    // This example assumes HNSWIndexManager.load can work with just the .hnsw if metadata is co-located or re-creatable.
    // Or, modify encoder to also return metadata buffer if needed for separate saving.
    console.log(`Index data buffer saved to ${indexFilePath} (metadata would be separate).`);
  } else {
    // If indexDataBuffer is not returned, it implies index.save() was called internally by buildVideo.
    console.log(`Index presumed saved by encoder at configured path: ${config.index.path}`);
  }

  // Retriever and Chat
  // Ensure the index path used by retriever matches where index was saved/serialized.
  // MemvidRetriever expects the base path (without .hnsw or .meta.json)
  const retriever = new MemvidRetriever("memory_ts.mp4", config.index.path!, config);
  await retriever.readyPromise; // Ensure retriever is initialized (loads index, ffmpeg for video verify)
  console.log("Retriever ready.");

  // Chat (LlmClient would need API keys configured in environment or config)
  // For a runnable example without API keys, use context-only chat:
  const chat = new MemvidChat(retriever, config); // No LlmClient for context-only
  chat.startSession();
  console.log("Chat session started (context-only).");

  const response = await chat.chat("What is this about?");
  console.log("Chat Response (from context):", response);

  const responseTwo = await chat.chat("Tell me about WASM.");
  console.log("Chat Response 2 (from context):", responseTwo);
}

main().catch(error => {
  console.error("Error in main execution:", error);
});
```

**Note:** More examples and a fully featured CLI are under development for the TypeScript version. The example above demonstrates core functionality in a Node.js environment.

## 🛠️ Advanced Configuration

Configuration is managed via the `MemvidConfig` object, typically initialized using `getDefaultConfig()` and then customized. Key areas include:
- `codecParameters`: Define settings for different video codecs (frame size, FPS, bitrate/CRF, internal codec names for ffmpeg.wasm).
- `embedding`: Specify embedding model details (name for Transformers.js, expected dimension).
- `index`: Configure the HNSW index (max elements, M, efConstruction, path for saving/loading).
- `llm`: Set up LLM providers, default models, and API key environment variable names.
- `chat`: Customize system prompts, context length, and history size for `MemvidChat`.
- `qr`: Control QR code generation parameters (error correction, size, colors).
- `performance`: Settings like prefetch frames for retriever (future) and timeouts.

Refer to `src/config.ts` for detailed interface definitions.

## 🐛 Troubleshooting

[Troubleshooting for Node.js/WASM version to be added. Common areas will include FFmpeg.wasm loading, HNSWlib.wasm initialization, and API key setup for LLMs.]

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details (to be updated for TS development).

**Typical Development Setup:**
```bash
git clone https://github.com/your-repo/memvid-ts.git # Replace with actual repo
cd memvid-ts
npm install
# To build:
npm run build # Or your specific build script in package.json
# To test:
npm test # Or jest, vitest, etc.
```
Consider using ESLint and Prettier for code style consistency.

## 🆚 Comparison with Traditional Solutions

| Feature             | Memvid (TS/WASM) | Vector DBs    | Traditional DBs |
|---------------------|--------------------|---------------|-----------------|
| Storage Efficiency  | ⭐⭐⭐⭐             | ⭐⭐            | ⭐⭐⭐            |
| Setup Complexity    | ⭐⭐⭐ (Node.js)   | Complex       | Complex         |
| Semantic Search     | ✅                 | ✅            | ❌              |
| Offline Usage       | ✅ (core logic)    | Limited/No    | ✅              |
| Browser Compatibility| ✅ (core logic)    | Limited/No    | Limited/No      |
| Portability         | Files (video, index) | Server-based  | Server-based    |
| Scalability (items) | Millions           | Millions      | Billions        |
| Cost (self-hosted)  | Free (compute)     | $$$ (infra)   | $$$ (infra)     |


## 📚 Examples

Further examples demonstrating browser usage, specific LLM integrations, and advanced configurations are planned.

## 🆘 Getting Help

- 📖 [Documentation] - (Link to future documentation)
- 💬 [Discussions] - (Link to GitHub Discussions for the new repo)
- 🐛 [Issue Tracker] - (Link to GitHub Issues for the new repo)

## 🔗 Links

- [GitHub Repository] - (Link to the new TypeScript project repository)
- [NPM Package] - (Link to npm package once published)

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

The TypeScript/Node.js version of Memvid builds upon concepts from the original Python project and leverages these amazing open-source libraries:
- **Core Processing & Indexing:**
  - `@ffmpeg/ffmpeg` (ffmpeg.wasm): For in-browser/Node.js video processing.
  - `@xenova/transformers`: For running sentence embeddings in JavaScript.
  - `hnswlib-wasm`: For efficient approximate nearest neighbor search using HNSW.
  - `qrcode`: For generating QR codes.
  - `pako`: For Gzip compression/decompression.
- **Document Parsing:**
  - `pdfjs-dist`: For parsing PDF documents.
  - `epub.js`: For parsing EPUB documents.
- **LLM Integration:**
  - `openai` (OpenAI SDK for Node.js/JS)
  - `@google/generative-ai` (Google AI JavaScript SDK)
  - `@anthropic-ai/sdk` (Anthropic SDK)
- **Development & Environment:**
  - TypeScript
  - Node.js

Special thanks to the developers and communities behind these projects!

## Running Tests

This project uses [Jest](https://jestjs.io/) with TypeScript. To run tests:

```
npm install
npm test
```

Jest is configured to use TypeScript via `ts-jest` and a dedicated `tsconfig.test.json`.
