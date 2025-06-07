import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testPathIgnorePatterns: ['/dist/'],
  transformIgnorePatterns: [
    '/dist/',
    '/node_modules/(?!(\@ffmpeg/ffmpeg|lru-cache|pako|qrcode|pdfjs-dist|epub.js|@zxing/library|@xenova/transformers)/)'
  ],
  modulePathIgnorePatterns: ['<rootDir>/dist/__tests__'],
  moduleNameMapper: {
    '^@ffmpeg/ffmpeg$': '<rootDir>/test/__mocks__/ffmpeg.js',
  },
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.test.json',
    },
  },
};

export default config; 