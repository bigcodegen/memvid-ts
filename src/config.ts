// 1. QrConfig Interface
export interface QrConfig {
  version?: number;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  boxSize?: number; // Size of each module/box in pixels
  border?: number; // Width of the quiet zone border in modules
  fillColor?: string; // Color of QR code modules (e.g., '#000000')
  backColor?: string; // Background color (e.g., '#FFFFFF')
}

// Expanded CodecConfig Interface
export interface CodecConfig {
  videoFileType: string; // e.g., "mp4", "webm"
  videoFps: number; // Target FPS for the encoded video
  frameHeight: number;
  frameWidth: number;
  videoCrf?: number; // Constant Rate Factor (for codecs like libx264, libvpx-vp9)
  videoBitrate?: string; // Target bitrate (e.g., "1M", "500k")
  codecNameInternal: string; // Codec name used by ffmpeg (e.g., "libx264", "vp9", "av1")
  pixFmt: string; // Pixel format (e.g., "yuv420p")
  extraFfmpegArgs?: string[]; // Array of additional ffmpeg arguments
}

// PerformanceConfig Interface
export interface PerformanceConfig {
  prefetchFrames?: number; // Number of frames retriever might prefetch
  asyncOperationTimeout?: number; // General timeout for async operations in ms
}

// Main MemvidConfig Interface
export interface MemvidConfig {
  chunkSize: number;
  overlap: number;
  codec: string; // Default codec key to use from codecParameters
  codecParameters: Record<string, CodecConfig>;

  tempDir?: string;

  retrieval: {
    cache_size: number;
    max_workers: number;
  };

  embedding: {
    model: string;
    dimension: number;
  };

  index: {
    type?: string;
    path?: string;
    maxElements?: number;
    M?: number;
    efConstruction?: number;
    efSearch?: number;
  };

  llm: {
    defaultModels: {
      openai: string;
      google: string;
      anthropic: string;
    };
    apiKeyEnvVars: {
      openai: string;
      google: string;
      anthropic: string;
    };
    maxContextTokensForContext?: number;
    maxTokens?: number;
  };

  chat?: {
    systemPrompt?: string;
    contextChunksPerQuery?: number;
    maxHistoryLength?: number;
  };

  // 2. Add qr to MemvidConfig
  qr?: QrConfig;

  // 4. Add performance to MemvidConfig
  performance?: PerformanceConfig;
}

// --- DEFAULT CONFIGURATIONS ---

const H264_CODEC_CONFIG_WASM: CodecConfig = {
  videoFileType: "mp4",
  videoFps: 30,
  frameHeight: 720,
  frameWidth: 1280,
  videoBitrate: "1500k", // Adjusted for 720p, was 2M
  codecNameInternal: "libx264", // Common in full ffmpeg, check ffmpeg.wasm build for availability
  pixFmt: "yuv420p", // Standard pixel format
  extraFfmpegArgs: ["-preset", "medium", "-tune", "stillimage"] // Tune for QR codes / static content
};

const VP9_CODEC_CONFIG_WASM: CodecConfig = {
  videoFileType: "webm",
  videoFps: 30,
  frameHeight: 720,
  frameWidth: 1280,
  videoBitrate: "1000k", // VP9 can often achieve better quality at lower bitrates
  codecNameInternal: "vp9", // Check ffmpeg.wasm build for VP9 support
  pixFmt: "yuv420p",
  // VP9 specific args might be needed, e.g. -deadline realtime -cpu-used, if available
  extraFfmpegArgs: ["-deadline", "good", "-cpu-used", "0"]
};

// Original MP4V config - might be less suitable for ffmpeg.wasm if it implies specific old MPEG-4 part 2
// For QR codes, a simple intra-frame codec or high-quality still image settings are good.
// If this implies generic mpeg4, it might not be ideal or well-supported in minimal ffmpeg.wasm builds.
// Let's keep it but perhaps make h264 the default for broader compatibility and quality.
const MP4V_LEGACY_CONFIG: CodecConfig = {
  videoFileType: "mp4",
  videoFps: 15,
  frameHeight: 256, // Small frame size, good for simple QRs
  frameWidth: 256,
  videoCrf: 20, // Lower CRF is better quality
  codecNameInternal: "mpeg4", // Generic MPEG-4 Part 2; libx264 is generally preferred
  pixFmt: "yuv420p",
  extraFfmpegArgs: ["-qscale:v", "5"] // Example: use qscale for older codecs if CRF not primary
};


const DEFAULT_CONFIG: MemvidConfig = {
  chunkSize: 1024,
  overlap: 32,
  codec: "h264Wasm", // Changed default codec to the new H264 profile
  codecParameters: {
    h264Wasm: H264_CODEC_CONFIG_WASM,
    vp9Wasm: VP9_CODEC_CONFIG_WASM,
    mp4vLegacy: MP4V_LEGACY_CONFIG
  },
  tempDir: "memvid_temp",
  retrieval: {
    cache_size: 100,
    max_workers: 4
  },
  embedding: {
    model: "Xenova/all-MiniLM-L6-v2",
    dimension: 384
  },
  index: {
    type: "HNSW",
    path: "memvid_index",
    maxElements: 10000,
    M: 16,
    efConstruction: 200,
    efSearch: 100
  },
  llm: {
    defaultModels: {
      openai: "gpt-3.5-turbo",
      google: "gemini-pro",
      anthropic: "claude-3-haiku-20240307"
    },
    apiKeyEnvVars: {
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      anthropic: "ANTHROPIC_API_KEY"
    },
    maxContextTokensForContext: 2000,
    maxTokens: 1024
  },
  chat: {
    systemPrompt: "You are a helpful AI assistant interacting with a user about a video's content. Use the provided context from the video to answer questions. Be concise and informative.",
    contextChunksPerQuery: 3,
    maxHistoryLength: 6
  },
  // 5. Add default QR settings
  qr: {
    errorCorrectionLevel: 'M',
    boxSize: 5, // pixels per module
    border: 4,  // modules
    fillColor: '#000000',
    backColor: '#FFFFFF'
  },
  // 5. Add default performance settings
  performance: {
    prefetchFrames: 10,
    asyncOperationTimeout: 30000 // 30 seconds
  }
};

export function getDefaultConfig(): MemvidConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

// 6. Implement getCodecParameters function
/**
 * Retrieves codec parameters from the configuration.
 * @param config The MemvidConfig object.
 * @param codecName Optional name of the codec to retrieve. If not provided, uses the default codec from config.
 * @returns The CodecConfig for the specified or default codec, or undefined if not found.
 */
export function getCodecParameters(config: MemvidConfig, codecName?: string): CodecConfig | undefined {
  const targetCodecName = codecName || config.codec;
  if (!targetCodecName) {
    console.warn("No codec name provided and no default codec set in config.");
    return undefined;
  }
  const params = config.codecParameters[targetCodecName];
  if (!params) {
    console.warn(`Codec parameters for "${targetCodecName}" not found.`);
    return undefined;
  }
  return params;
}
