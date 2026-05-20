/**
 * Gloo AI provider integration tests.
 *
 * Two layers:
 *   1. Catalog/static — runs everywhere. Asserts the 23-model catalog is
 *      registered, has the expected shape, and that the toolcall blocklist
 *      contains the three known-bad models.
 *   2. Live — runs only when GLOO_CLIENT_ID + GLOO_CLIENT_SECRET are set in
 *      the environment. Mints a real OAuth bearer, streams against three
 *      representative models (Sonnet 4.6, GPT-4.1, DeepSeek R1), and
 *      confirms the platform's tool-rejection contract for DeepSeek R1.
 *
 * The live tier is gated, never required, and times out at 30s per case so
 * it can run as part of the regular `npm test` without flaking CI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { clearGlooModelsCache, fetchGlooModels } from "../src/models.gloo.fetch.js";
import { getModel, getModels, getProviders } from "../src/models.js";
import {
	GLOO_TOOLCALL_BLOCKLIST,
	getGlooToolcallBlocklist,
	setGlooToolcallBlocklist,
	stripChatCompletionsSuffix,
} from "../src/providers/gloo.js";
import { streamSimple } from "../src/stream.js";
import type { Context } from "../src/types.js";

const HAS_GLOO_CREDS = !!(process.env.GLOO_CLIENT_ID && process.env.GLOO_CLIENT_SECRET);

describe("Gloo AI catalog (static)", () => {
	it("registers gloo as a provider", () => {
		expect(getProviders()).toContain("gloo");
	});

	it("seeds 22 models in the catalog", () => {
		// 6 Anthropic + 3 Google + 7 OpenAI + 6 open-source = 22.
		// (gloo-google-gemini-3-pro-preview was dropped 2026-04-27 from upstream.)
		const models = getModels("gloo");
		expect(models.length).toBe(22);
	});

	it("every gloo model is tagged with api='gloo-openai-completions' and provider='gloo'", () => {
		for (const model of getModels("gloo")) {
			expect(model.api).toBe("gloo-openai-completions");
			expect(model.provider).toBe("gloo");
			expect(model.baseUrl).toMatch(/\/ai\/v2$/);
		}
	});

	it("getModel('gloo', 'gloo-anthropic-claude-sonnet-4.6') resolves", () => {
		const m = getModel("gloo", "gloo-anthropic-claude-sonnet-4.6");
		expect(m).toBeTruthy();
		expect(m.id).toBe("gloo-anthropic-claude-sonnet-4.6");
		expect(m.contextWindow).toBe(200_000);
		expect(m.reasoning).toBe(true);
		expect(m.input).toContain("image");
	});

	it("toolcall blocklist contains the three known-bad models", () => {
		expect(GLOO_TOOLCALL_BLOCKLIST.has("gloo-deepseek-r1")).toBe(true);
		expect(GLOO_TOOLCALL_BLOCKLIST.has("gloo-meta-llama-4-maverick")).toBe(true);
		expect(GLOO_TOOLCALL_BLOCKLIST.has("gloo-meta-llama-3.1-8b-instruct")).toBe(true);
		// And nothing else — keeps the list tight.
		expect(GLOO_TOOLCALL_BLOCKLIST.size).toBe(3);
	});

	it("decommissioned models are absent from the catalog", () => {
		// gloo-google-gemini-3-pro-preview was removed on 2026-04-27 because
		// /ai/v2/models started returning "model not supported".
		const m = getModel("gloo", "gloo-google-gemini-3-pro-preview" as never);
		expect(m).toBeUndefined();
	});

	it("stripChatCompletionsSuffix peels '/ai/v2' off the model baseUrl", () => {
		expect(stripChatCompletionsSuffix("https://platform.ai.gloo.com/ai/v2")).toBe("https://platform.ai.gloo.com");
		expect(stripChatCompletionsSuffix("https://platform.ai.gloo.com/ai/v2/")).toBe("https://platform.ai.gloo.com");
		expect(stripChatCompletionsSuffix("http://localhost:8000/ai/v2")).toBe("http://localhost:8000");
	});

	it("env-api-keys reports gloo configured iff both env vars are set", () => {
		const original = { id: process.env.GLOO_CLIENT_ID, secret: process.env.GLOO_CLIENT_SECRET };
		try {
			process.env.GLOO_CLIENT_ID = "test-id";
			process.env.GLOO_CLIENT_SECRET = "test-secret";
			expect(findEnvKeys("gloo")).toEqual(["GLOO_CLIENT_ID", "GLOO_CLIENT_SECRET"]);
			expect(getEnvApiKey("gloo")).toBe("<authenticated>");

			delete process.env.GLOO_CLIENT_SECRET;
			expect(findEnvKeys("gloo")).toBeUndefined();
			expect(getEnvApiKey("gloo")).toBeUndefined();
		} finally {
			if (original.id !== undefined) process.env.GLOO_CLIENT_ID = original.id;
			else delete process.env.GLOO_CLIENT_ID;
			if (original.secret !== undefined) process.env.GLOO_CLIENT_SECRET = original.secret;
			else delete process.env.GLOO_CLIENT_SECRET;
		}
	});
});

describe("fetchGlooModels (dynamic discovery)", () => {
	const realFetch = globalThis.fetch;

	function mockModelsResponse(payload: unknown, ok = true, status = 200): void {
		globalThis.fetch = vi.fn(async () => ({
			ok,
			status,
			statusText: ok ? "OK" : "Error",
			json: async () => payload,
			text: async () => JSON.stringify(payload),
		})) as unknown as typeof fetch;
	}

	const samplePayload = {
		object: "list",
		data: [
			{
				id: "gloo-openai-gpt-5-mini",
				name: "GPT-5 Mini",
				context_window: 400_000,
				max_output_tokens: 128_000,
				input_modalities: ["text", "image"],
				supports_reasoning: true,
				supports_tools: true,
				pricing: {
					input: { rate_per_1k_tokens: "0.00025", rate_per_1m_tokens: "0.25" },
					output: { rate_per_1k_tokens: "0.002", rate_per_1m_tokens: "2" },
				},
			},
			{
				id: "gloo-google-gemini-2.5-flash",
				name: "Gemini 2.5 Flash",
				context_window: 1_048_576,
				max_output_tokens: 65_500,
				// includes audio/video which pi-ai's Model.input cannot represent
				input_modalities: ["text", "image", "audio", "video"],
				supports_reasoning: false,
				supports_tools: true,
			},
			{
				id: "gloo-deepseek-r1",
				name: "DeepSeek R1",
				context_window: 128_000,
				max_output_tokens: 8_192,
				input_modalities: ["text"],
				supports_reasoning: true,
				supports_tools: false,
			},
		],
	};

	beforeEach(() => {
		clearGlooModelsCache();
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		clearGlooModelsCache();
		vi.restoreAllMocks();
	});

	it("maps the platform response to pi-ai model shape", async () => {
		mockModelsResponse(samplePayload);
		const { models } = await fetchGlooModels({ baseUrl: "https://platform.ai.gloo.com", force: true });

		expect(models).toHaveLength(3);
		const mini = models.find((m) => m.id === "gloo-openai-gpt-5-mini");
		expect(mini).toBeTruthy();
		expect(mini?.api).toBe("gloo-openai-completions");
		expect(mini?.provider).toBe("gloo");
		expect(mini?.baseUrl).toBe("https://platform.ai.gloo.com/ai/v2");
		expect(mini?.reasoning).toBe(true);
		expect(mini?.input).toEqual(["text", "image"]);
		expect(mini?.contextWindow).toBe(400_000);
		expect(mini?.maxTokens).toBe(128_000);
		// `pricing` maps to a per-million-token rate-card estimate (input/output
		// only; the endpoint exposes no cache tiers, so those stay 0).
		expect(mini?.cost).toEqual({ input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0 });
	});

	it("maps cost to 0 when a model has no pricing block", async () => {
		mockModelsResponse(samplePayload);
		const { models } = await fetchGlooModels({ force: true });
		// The Gemini sample carries no `pricing` — degrade to no estimate, not NaN.
		const flash = models.find((m) => m.id === "gloo-google-gemini-2.5-flash");
		expect(flash?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("maps a non-numeric rate to 0 rather than NaN", async () => {
		mockModelsResponse({
			object: "list",
			data: [
				{
					id: "gloo-broken-pricing",
					name: "Broken Pricing",
					context_window: 1000,
					max_output_tokens: 100,
					input_modalities: ["text"],
					pricing: { input: { rate_per_1m_tokens: "n/a" }, output: {} },
				},
			],
		});
		const { models } = await fetchGlooModels({ force: true });
		expect(models[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("filters audio/video out of input modalities", async () => {
		mockModelsResponse(samplePayload);
		const { models } = await fetchGlooModels({ force: true });
		const flash = models.find((m) => m.id === "gloo-google-gemini-2.5-flash");
		expect(flash?.input).toEqual(["text", "image"]);
	});

	it("collects supports_tools === false into toolUnsupportedIds", async () => {
		mockModelsResponse(samplePayload);
		const { toolUnsupportedIds } = await fetchGlooModels({ force: true });
		expect(toolUnsupportedIds.has("gloo-deepseek-r1")).toBe(true);
		expect(toolUnsupportedIds.has("gloo-openai-gpt-5-mini")).toBe(false);
		expect(toolUnsupportedIds.size).toBe(1);
	});

	it("throws on non-200 so callers can fall back", async () => {
		mockModelsResponse({ error: "boom" }, false, 503);
		await expect(fetchGlooModels({ force: true })).rejects.toThrow(/503/);
	});

	it("throws on a malformed (non-list) payload", async () => {
		mockModelsResponse({ object: "not-a-list", data: "nope" });
		await expect(fetchGlooModels({ force: true })).rejects.toThrow(/list/);
	});

	it("caches within the TTL — second call does not re-fetch", async () => {
		mockModelsResponse(samplePayload);
		await fetchGlooModels({ baseUrl: "https://platform.ai.gloo.com" });
		await fetchGlooModels({ baseUrl: "https://platform.ai.gloo.com" });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

describe("Gloo tool-call blocklist (mutable)", () => {
	afterEach(() => {
		// Reset to the static seed for other tests in the suite.
		setGlooToolcallBlocklist(GLOO_TOOLCALL_BLOCKLIST);
	});

	it("repopulates from a dynamic set", () => {
		setGlooToolcallBlocklist(new Set(["gloo-deepseek-r1", "gloo-some-new-no-tools-model"]));
		const live = getGlooToolcallBlocklist();
		expect(live.has("gloo-some-new-no-tools-model")).toBe(true);
		expect(live.has("gloo-meta-llama-4-maverick")).toBe(false);
	});

	it("falls back to the static seed when given an empty set", () => {
		setGlooToolcallBlocklist([]);
		const live = getGlooToolcallBlocklist();
		expect(live.has("gloo-deepseek-r1")).toBe(true);
		expect(live.has("gloo-meta-llama-4-maverick")).toBe(true);
		expect(live.has("gloo-meta-llama-3.1-8b-instruct")).toBe(true);
	});
});

describe.skipIf(!HAS_GLOO_CREDS)("Gloo AI live smoke (requires GLOO_CLIENT_ID + GLOO_CLIENT_SECRET)", () => {
	function shortPrompt(): Context {
		return {
			systemPrompt: "Reply with exactly one short sentence and nothing else.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Say hi from Gloo to pi-mono." }],
					timestamp: Date.now(),
				},
			],
		};
	}

	it("streams gloo-anthropic-claude-sonnet-4.6 to a finished response", { timeout: 30000, retry: 1 }, async () => {
		const model = getModel("gloo", "gloo-anthropic-claude-sonnet-4.6");
		const result = await streamSimple(model, shortPrompt(), { maxTokens: 64 }).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.errorMessage).toBeFalsy();
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("");
		expect(text.length).toBeGreaterThan(0);
	});

	it("streams gloo-openai-gpt-4.1 to a finished response", { timeout: 30000, retry: 1 }, async () => {
		const model = getModel("gloo", "gloo-openai-gpt-4.1");
		const result = await streamSimple(model, shortPrompt(), { maxTokens: 64 }).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.errorMessage).toBeFalsy();
	});

	it(
		"streams gloo-deepseek-v3.2 (open-source representative) to a finished response",
		{ timeout: 30000, retry: 1 },
		async () => {
			// We pick V3.2 (not R1) as the open-source live smoke because as of
			// 2026-04-29 the Gloo platform returns
			//   { code: 3001, type: "internal_error", message: "Streaming error occurred", fault: "internal" }
			// for `gloo-deepseek-r1` while V3.2 and Chat V3.1 both stream cleanly.
			// Trace logged via x-sentry-trace-id; see
			// .context/logs/2026-04-29-gloo-deepseek-r1-platform-regression.md.
			const model = getModel("gloo", "gloo-deepseek-v3.2");
			const result = await streamSimple(model, shortPrompt(), { maxTokens: 128 }).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.errorMessage).toBeFalsy();
		},
	);

	it(
		"strips tools for blocklisted models — vanilla request to gloo-meta-llama-4-maverick succeeds with tools client-side-removed",
		{ timeout: 30000, retry: 1 },
		async () => {
			const model = getModel("gloo", "gloo-meta-llama-4-maverick");
			const ctx: Context = {
				...shortPrompt(),
				tools: [
					{
						name: "noop",
						description: "Returns nothing.",
						parameters: { type: "object", properties: {} },
					},
				],
			};
			const result = await streamSimple(model, ctx, { maxTokens: 128 }).result();
			// Wrapper drops tools client-side, so the platform never sees them
			// and the request succeeds instead of hitting HTTP 400
			// "model does not support function calling".
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.errorMessage).toBeFalsy();
		},
	);
});
