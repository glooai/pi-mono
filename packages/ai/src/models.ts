// Type-only: the generated multi-provider catalog is used solely for the
// `AllModels` type below (autocomplete in getModel/getModels). It is NOT loaded
// at runtime, so non-Gloo providers never enter the registry.
import type { MODELS } from "./models.generated.ts";
import { MODELS_GLOO } from "./models.gloo.ts";
import type { Api, KnownProvider, Model, ModelThinkingLevel, Usage } from "./types.ts";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// This is the GlooAI fork: Gloo is the ONLY provider. The upstream-generated
// multi-provider catalog (`MODELS`) is deliberately NOT loaded into the runtime
// registry, so `getProviders()` returns just `["gloo"]` and the model picker /
// login surfaces in the coding-agent only ever show Gloo. `MODELS` is still
// imported below purely for the type-level `AllModels` so `getModel`/`getModels`
// keep their generic autocomplete; flipping a single line here re-enables the
// full upstream catalog if this fork ever needs it.
//
// MODELS_GLOO is the sole runtime source. It survives an upstream regeneration
// (`npm run generate-models`) because the regen rewrites models.generated.ts but
// never touches models.gloo.ts.
for (const [provider, models] of Object.entries(MODELS_GLOO)) {
	const providerModels = modelRegistry.get(provider) ?? new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

// Merged type-level catalog so getModel("gloo", "gloo-...") gets autocomplete
// from the MODELS_GLOO file just like the auto-generated MODELS entries.
type AllModels = typeof MODELS & typeof MODELS_GLOO;

type ModelApi<
	TProvider extends keyof AllModels,
	TModelId extends keyof AllModels[TProvider],
> = AllModels[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends keyof AllModels, TModelId extends keyof AllModels[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider as string);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends keyof AllModels>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof AllModels[TProvider]>>[] {
	const models = modelRegistry.get(provider as string);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof AllModels[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
