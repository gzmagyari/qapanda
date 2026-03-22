import type { ByteChunkReadResult, RangeReadResult, TailReadResult } from "../types.js";
export declare function readByteChunk(filePath: string, byteStart: number, maxBytes: number): Promise<ByteChunkReadResult>;
export declare function readFull(filePath: string, maxBytes: number): Promise<ByteChunkReadResult>;
export declare function readTailLines(filePath: string, lineCount: number, maxBytes: number): Promise<TailReadResult>;
export declare function readLineRange(filePath: string, startLine: number, endLine: number | undefined, maxBytes: number): Promise<RangeReadResult>;
