// Types for claude-core.mjs (plain JS so the cabin-advisor scripts can import it with
// a bare `node`). Keep in step with the .mjs; llm.ts and the tests import through this.

export declare const API_BASE: string;
export declare const API_VERSION: string;
export declare const MODELS: Readonly<{ DEFAULT: string; CHEAP: string }>;
export declare const BULK_MIN_CALLS: number;
export declare const BULK_MIN_DOLLARS: number;
export declare const CACHE_MIN_SHARED_TOKENS: number;
export declare const ASSUME: Readonly<{ batchCacheHitRate: number; syncCacheHitRate: number; retryRate: number }>;
export interface ModelPrice { input: number; output: number; write5m: number; write1h: number; read: number }
export declare const PRICES: Readonly<Record<string, ModelPrice>>;
export declare const BATCH_FACTOR: number;
export declare const WEB_SEARCH_DOLLARS: number;
export declare const CACHE_MIN_PREFIX_TOKENS: Readonly<Record<string, number>>;
export declare const IMAGE_TOKENS: number;
export declare const TOOL_OVERHEAD_TOKENS: number;

export declare function canonicalModel(model: string): string;
export declare function priceFor(model: string): ModelPrice;
export declare function rejectsForcedToolChoice(model: string): boolean;
export declare function rejectsSampling(model: string): boolean;
export declare function supportsBetweenTools(model: string): boolean;
export interface StructuredCallShape {
  tool_choice: Record<string, unknown>;
  instruction: string;
  forced: boolean;
  thinking?: Record<string, unknown>;
}
export declare function structuredCallShape(model: string, toolName: string): StructuredCallShape;

export declare class JobTagError extends Error {}
export declare function registeredJobs(service?: string): string[];
export declare function jobUserId(job: string, service?: string): string;
export declare function withJobTag<T extends Record<string, unknown>>(body: T, job: string, service?: string): T & { metadata: { user_id: string } };
export declare function assertRequestAllowed(body: Record<string, unknown>): void;

export declare function estimateTokens(text: unknown): number;
export interface RenderedBlock { key: string; tokens: number; cached: boolean; units: { key: string; tokens: number; sample: string }[] }
export declare function renderBlocks(params: Record<string, unknown>): RenderedBlock[];
export interface Analysis {
  perRequest: { inputTokens: number; cachedPrefixTokens: number; sharedUncachedTokens: number }[];
  maxSharedUncachedTokens: number;
  sharedSample: string;
  problems: string[];
}
export declare function analyseRequests(paramsList: Record<string, unknown>[]): Analysis;
export interface RunEstimate {
  batch: boolean; calls: number; maxCalls: number; attempts: number;
  inputTokens: number; cachedTokens: number; outputCeilingTokens: number;
  ceiling: number; expected: number; notes: string[];
}
export declare function estimateRun(opts: {
  paramsList: Record<string, unknown>[]; analysis?: Analysis; attempts?: number; batch: boolean;
  cacheTtl?: "5m" | "1h"; expectedOutputTokens?: number;
}): RunEstimate;

export declare class BulkRuleError extends Error {
  rule: "cache" | "batch" | "approval" | "budget";
  constructor(rule: string, message: string);
}
export declare function bulkFlags(argv?: string[]): { approvedCost?: number; noBatchReason?: string };
export declare function defaultAuditPath(): string;
export declare function fileAudit(entry: Record<string, unknown>): void;

export interface GateOptions {
  job: string;
  service?: string;
  paramsList: Record<string, unknown>[];
  attempts?: number;
  expectedOutputTokens?: number;
  /** true = always batch; false = one call at a time (a bulk run then needs noBatchReason); omitted = batch when bulk. */
  batch?: boolean;
  noBatchReason?: string;
  approvedCost?: number;
  cacheTtl?: "5m" | "1h";
  log?: (line: string) => void;
  audit?: (entry: Record<string, unknown>) => void;
}
export interface BulkPlan {
  bulk: boolean; mode: "batch" | "sync"; estimate: RunEstimate; analysis: Analysis; userId: string; approvedCost?: number;
}
export declare function gateBulkRun(opts: GateOptions): BulkPlan;

export declare function resolveApiKey(): string;
export declare function _resetSyncCounter(): void;
export declare function claudeSync(params: Record<string, unknown>, opts: {
  job: string; service?: string; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number;
}): Promise<any>;
export declare function usageCost(model: string, usage: Record<string, unknown> | undefined, opts?: { batch?: boolean }): number;
export declare function defaultStateDir(): string;

export interface BulkRequest { custom_id: string; params: Record<string, unknown>; /** defaults to the run's job */ job?: string }
export interface BulkResult { ok: boolean; message?: any; error?: string; cost?: number }
export interface BulkRunOptions extends Omit<GateOptions, "paramsList"> {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  pollMs?: number;
  maxWaitMs?: number;
  stateDir?: string | null;
  sleep?: (ms: number) => Promise<void>;
}
export declare function openBulkRun(opts: BulkRunOptions & { paramsList: Record<string, unknown>[] }): {
  plan: BulkPlan;
  execute(requests: BulkRequest[]): Promise<Map<string, BulkResult>>;
  spent(): number;
};
export declare function runBulk(opts: BulkRunOptions & { requests: BulkRequest[] }): Promise<{
  results: Map<string, BulkResult>; plan: BulkPlan; spent: number;
}>;
export declare function messageText(message: unknown): string;
