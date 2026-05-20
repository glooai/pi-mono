/**
 * Dynamic Gloo AI model discovery.
 *
 * Fetches the live model catalog from the platform's public
 * `GET ${GLOO_BASE_URL}/platform/v2/models` endpoint instead of relying on the
 * hand-maintained static catalog in `models.gloo.ts`. This mirrors how Gloo's
 * own apps (e.g. gloo-ai-studio's `useModels` hook) discover models at runtime.
 *
 * Notes:
 * - The endpoint is **unauthenticated** — unlike the `/ai/v2` inference path, it
 *   needs no OAuth bearer. So this helper is independent of the OAuth flow in
 *   `utils/oauth/gloo.ts`; only inference still mints a token.
 * - The static catalog in `models.gloo.ts` remains the offline fallback (and the
 *   source of `GlooModelId` autocomplete). This helper is consumed by the
 *   coding-agent's `ModelRegistry.hydrateGlooModels()`, which keeps the static
 *   set in place if the fetch fails.
 * - Each model's `cost` is mapped from the endpoint's `pricing` block so the
 *   coding-agent statusline can show a **rate-card cost estimate** (tokens ×
 *   published per-million rates). This is an estimate, not the invoiced amount:
 *   Gloo's `/ai/v2` inference response does not return an authoritative
 *   per-request cost (no `cost` field, no `x-litellm-response-cost` header), so
 *   the closest a client can get is the published list rate applied to the
 *   server-returned token counts. The endpoint only exposes `input`/`output`
 *   rates — there are no cache tiers — so `cacheRead`/`cacheWrite` stay 0.
 *   The static catalog in `models.gloo.ts` keeps `cost: 0` as its offline
 *   fallback (no estimate when the fetch is unavailable).
 *
 * Response shape is owned by `ai-api/app/api/platform/models_v2_get.py`
 * (`ModelsV2Response` / `ModelResponse`).
 */

import type { Model } from "./types.ts";

const DEFAULT_BASE_URL = "https://platform.ai.gloo.com";
const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000; // mirror gloo-ai-studio's React Query staleTime

/** A single per-token rate tier as returned by the platform. Rates are strings. */
interface GlooPricingTier {
	rate_per_1k_tokens?: string;
	rate_per_1m_tokens?: string;
}

/** Per-model pricing block. The endpoint exposes input/output only (no cache tiers). */
interface GlooPricing {
	input?: GlooPricingTier;
	output?: GlooPricingTier;
}

/** Subset of the platform's `ModelResponse` that we actually consume. */
interface GlooModelResponse {
	id: string;
	name: string;
	context_window: number;
	max_output_tokens: number;
	input_modalities?: string[];
	supports_reasoning?: boolean;
	supports_tools?: boolean;
	pricing?: GlooPricing;
}

interface GlooModelsV2Response {
	object: string;
	data: GlooModelResponse[];
}

export interface FetchedGlooModels {
	/** Live catalog mapped to pi-ai's model shape. */
	models: Model<"gloo-openai-completions">[];
	/** Model ids the platform reports as `supports_tools: false`. */
	toolUnsupportedIds: Set<string>;
}

export interface FetchGlooModelsOptions {
	/** Defaults to `GLOO_BASE_URL` env, else `https://platform.ai.gloo.com`. */
	baseUrl?: string;
	/** Caller cancellation. Merged with the internal timeout signal. */
	signal?: AbortSignal;
	/** Per-request timeout. Defaults to 5000ms. */
	timeoutMs?: number;
	/** Bypass the in-memory cache and force a network fetch. */
	force?: boolean;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function resolveBaseUrl(baseUrl?: string): string {
	return normalizeBaseUrl(baseUrl ?? process.env.GLOO_BASE_URL ?? DEFAULT_BASE_URL);
}

/** Inference endpoint baseUrl for a discovered model — matches `glooBaseUrl()`. */
function inferenceBaseUrl(base: string): string {
	return `${base}/ai/v2`;
}

function mapModalities(modalities: string[] | undefined): ("text" | "image")[] {
	const mapped = (modalities ?? []).filter((m): m is "text" | "image" => m === "text" || m === "image");
	return mapped.length > 0 ? mapped : ["text"];
}

/**
 * Parse a per-million-token rate string (e.g. `"0.15"`) into a number.
 * Missing or non-numeric rates map to 0 so a malformed pricing block degrades
 * to "no estimate" rather than NaN-poisoning `calculateCost`.
 */
function parseRatePerMillion(tier: GlooPricingTier | undefined): number {
	const rate = Number.parseFloat(tier?.rate_per_1m_tokens ?? "");
	return Number.isFinite(rate) ? rate : 0;
}

/**
 * Map the endpoint's `pricing` block to pi-ai's `cost` (per-million-token rates).
 * The platform exposes input/output only, so cache tiers stay 0 — `calculateCost`
 * then estimates cost as `tokens × rate`. See the module header on why this is an
 * estimate rather than the invoiced amount.
 */
function mapCost(pricing: GlooPricing | undefined): Model<"gloo-openai-completions">["cost"] {
	return {
		input: parseRatePerMillion(pricing?.input),
		output: parseRatePerMillion(pricing?.output),
		cacheRead: 0,
		cacheWrite: 0,
	};
}

function mapModel(entry: GlooModelResponse, base: string): Model<"gloo-openai-completions"> {
	return {
		id: entry.id,
		name: entry.name,
		api: "gloo-openai-completions",
		provider: "gloo",
		baseUrl: inferenceBaseUrl(base),
		reasoning: entry.supports_reasoning ?? false,
		input: mapModalities(entry.input_modalities),
		cost: mapCost(entry.pricing),
		contextWindow: entry.context_window,
		maxTokens: entry.max_output_tokens,
	};
}

// Cache + in-flight coalescing keyed by base URL, mirroring the pattern in
// utils/oauth/gloo.ts so concurrent callers in the same process share one fetch.
interface CacheEntry {
	value: FetchedGlooModels;
	expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<FetchedGlooModels>>();

function mergeAbortSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!external) {
		return timeoutSignal;
	}
	// AbortSignal.any is available in Node 20.3+/Bun; both are pi-mono baselines.
	return AbortSignal.any([timeoutSignal, external]);
}

async function doFetch(base: string, timeoutMs: number, signal?: AbortSignal): Promise<FetchedGlooModels> {
	const endpoint = `${base}/platform/v2/models`;
	const response = await fetch(endpoint, {
		method: "GET",
		headers: { Accept: "application/json" },
		signal: mergeAbortSignals(timeoutMs, signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Gloo models request failed (${response.status} ${response.statusText}): ${text.slice(0, 300)}`);
	}

	const data = (await response.json()) as GlooModelsV2Response;
	if (data?.object !== "list" || !Array.isArray(data.data)) {
		throw new Error("Gloo models response was not a { object: 'list', data: [...] } payload");
	}

	const models: Model<"gloo-openai-completions">[] = [];
	const toolUnsupportedIds = new Set<string>();
	for (const entry of data.data) {
		if (!entry?.id) continue;
		models.push(mapModel(entry, base));
		if (entry.supports_tools === false) {
			toolUnsupportedIds.add(entry.id);
		}
	}

	if (models.length === 0) {
		throw new Error("Gloo models response contained no usable models");
	}

	return { models, toolUnsupportedIds };
}

/**
 * Fetch the live Gloo model catalog. Cached per base URL with a short TTL and
 * in-flight coalescing. Throws on network/HTTP/shape errors — callers that want
 * graceful fallback (the registry hydration path) should catch.
 */
export async function fetchGlooModels(options: FetchGlooModelsOptions = {}): Promise<FetchedGlooModels> {
	const base = resolveBaseUrl(options.baseUrl);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	if (!options.force) {
		const cached = cache.get(base);
		if (cached && Date.now() < cached.expiresAt) {
			return cached.value;
		}
		const inFlight = pending.get(base);
		if (inFlight) {
			return inFlight;
		}
	}

	const promise = doFetch(base, timeoutMs, options.signal)
		.then((value) => {
			cache.set(base, { value, expiresAt: Date.now() + CACHE_TTL_MS });
			return value;
		})
		.finally(() => {
			pending.delete(base);
		});

	pending.set(base, promise);
	return promise;
}

/** Clear the in-memory Gloo models cache. Test/debug helper. */
export function clearGlooModelsCache(baseUrl?: string): void {
	if (baseUrl === undefined) {
		cache.clear();
		pending.clear();
		return;
	}
	const base = resolveBaseUrl(baseUrl);
	cache.delete(base);
	pending.delete(base);
}
