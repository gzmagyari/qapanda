export declare function ensureDir(dirPath: string): Promise<void>;
export declare function pathExists(targetPath: string): Promise<boolean>;
export declare function readJsonFile<T>(filePath: string): Promise<T>;
export declare function writeJsonAtomic(filePath: string, value: unknown, indent?: number): Promise<void>;
export declare function safeStatSize(filePath: string): Promise<number>;
export declare function listSubdirectories(dirPath: string): Promise<string[]>;
export declare function sleep(ms: number): Promise<void>;
