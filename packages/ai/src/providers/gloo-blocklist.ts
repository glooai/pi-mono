/**
 * Gloo AI tool-call blocklist.
 *
 * Lives in its own dependency-free module (no provider-SDK imports) so the
 * package barrel can re-export it without eagerly pulling in the OpenAI SDK via
 * `providers/gloo.ts` (which statically imports `openai-completions.ts`). The
 * lazy-module-load invariant — importing the root barrel must not load any
 * provider SDK — is enforced by `test/lazy-module-load.test.ts`.
 *
 * The static seed mirrors the models the Gloo platform rejects with HTTP 400
 * "model does not support function calling" (verified 2026-04-27). At runtime
 * the coding-agent's `ModelRegistry.hydrateGlooModels()` repopulates the live
 * set from the platform's `supports_tools` flags via `setGlooToolcallBlocklist`.
 */

const STATIC_TOOLCALL_BLOCKLIST: readonly string[] = [
	"gloo-deepseek-r1",
	"gloo-meta-llama-4-maverick",
	"gloo-meta-llama-3.1-8b-instruct",
];

/** Frozen snapshot of the static seed. Live state lives in the mutable set below. */
export const GLOO_TOOLCALL_BLOCKLIST: ReadonlySet<string> = new Set(STATIC_TOOLCALL_BLOCKLIST);

// Live, mutable blocklist. Seeded with the static set; repopulated at runtime
// from the dynamic model catalog (supports_tools === false).
let glooToolcallBlocklist = new Set<string>(STATIC_TOOLCALL_BLOCKLIST);

/**
 * Replace the live tool-call blocklist (called after a successful dynamic model
 * fetch). Empty input resets to the static fallback so we never end up with an
 * empty blocklist from a degraded response.
 */
export function setGlooToolcallBlocklist(ids: Iterable<string>): void {
	const next = new Set(ids);
	glooToolcallBlocklist = next.size > 0 ? next : new Set(STATIC_TOOLCALL_BLOCKLIST);
}

/** Inspect the current live tool-call blocklist. */
export function getGlooToolcallBlocklist(): ReadonlySet<string> {
	return glooToolcallBlocklist;
}

/** Whether the Gloo platform rejects tool/function calling for this model id. */
export function glooModelRejectsTools(modelId: string): boolean {
	return glooToolcallBlocklist.has(modelId);
}
