import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";

const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;

afterEach(() => {
	if (originalFireworksApiKey === undefined) {
		delete process.env.FIREWORKS_API_KEY;
	} else {
		process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
	}
});

describe("Fireworks models", () => {
	// GlooAI fork: Gloo is the only provider, so the generated Fireworks catalog
	// is intentionally not loaded into the runtime registry. The env-key
	// resolution helpers are provider-agnostic and unaffected by that gating, so
	// they keep their coverage below.
	it("does not register Fireworks models in the Gloo-only catalog", () => {
		expect(getModel("fireworks", "accounts/fireworks/models/kimi-k2p6")).toBeUndefined();
		expect(getModel("fireworks", "accounts/fireworks/routers/kimi-k2p5-turbo")).toBeUndefined();
	});

	it("resolves FIREWORKS_API_KEY from the environment", () => {
		process.env.FIREWORKS_API_KEY = "test-fireworks-key";

		expect(findEnvKeys("fireworks")).toEqual(["FIREWORKS_API_KEY"]);
		expect(getEnvApiKey("fireworks")).toBe("test-fireworks-key");
	});
});
