declare module '@ffmpeg/ffmpeg' {
  export class FFmpeg {
    FS(method: string, ...args: any[]): any;
    run(...args: any[]): Promise<void>;
    isLoaded?(): boolean;
    loaded?: boolean;
  }
  export function createFFmpeg(options?: any): FFmpeg;
} 