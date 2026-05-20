import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { isApiKeyLoginProvider } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		if (originalOpenAiApiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = originalOpenAiApiKey;
		}
	});

	it("keeps built-in API key providers separate from OAuth-only providers", () => {
		// In the gloo-only fork, API_KEY_LOGIN_PROVIDERS is empty, so there are no
		// built-in API-key login providers. The contract is now:
		//   - a built-in model provider id => false
		//   - an OAuth provider id => false
		//   - any other (unknown) id => true via the !oauthProviderIds fallback
		const oauthProviderIds = new Set(["gloo", "github-copilot", "custom-oauth"]);
		const builtInProviderIds = new Set(["gloo"]);

		expect(isApiKeyLoginProvider("anthropic", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.anthropic).toBe("Anthropic");
		expect(isApiKeyLoginProvider("openai", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("github-copilot", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("amazon-bedrock", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("custom-oauth", oauthProviderIds, builtInProviderIds)).toBe(false);
		// Unknown providers (not a model provider, not OAuth) are treated as API-key login.
		expect(isApiKeyLoginProvider("custom-api", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("some-proxy", oauthProviderIds, builtInProviderIds)).toBe(true);
		// A built-in model provider id is not an API-key login provider.
		expect(isApiKeyLoginProvider("gloo", oauthProviderIds, builtInProviderIds)).toBe(false);
		// OAuth provider ids are not API-key login providers.
		expect(isApiKeyLoginProvider("github-copilot", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("custom-oauth", oauthProviderIds, builtInProviderIds)).toBe(false);
	});

	it("shows stored OAuth auth distinctly in the API key selector", () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "anthropic", name: "Anthropic", authType: "api_key" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Anthropic");
		expect(output).toContain("subscription configured");
	});

	it("shows a stored OAuth credential label when present", () => {
		const authStorage = AuthStorage.inMemory({
			gloo: {
				type: "oauth",
				access: "access-token",
				refresh: "client-secret",
				expires: Date.now() + 60_000,
				clientId: "client-id",
				baseUrl: "https://platform.ai.gloo.com",
				label: "servant-internal",
			},
		});
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "gloo", name: "Gloo AI", authType: "oauth" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Gloo AI");
		expect(output).toContain("servant-internal configured");
	});

	it("shows environment API key auth as configured", () => {
		process.env.OPENAI_API_KEY = "test-openai-key";
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "openai", name: "OpenAI", authType: "api_key" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("OpenAI");
		expect(output).toContain("✓ env: OPENAI_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows custom provider environment API key auth from status resolver", () => {
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "ollama", name: "ollama", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "environment", label: "OLLAMA_API_KEY" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("ollama");
		expect(output).toContain("✓ env: OLLAMA_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json API key auth as configured", () => {
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "local-proxy", name: "local-proxy", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_key" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("local-proxy");
		expect(output).toContain("✓ key in models.json");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json command auth as configured", () => {
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			[{ id: "op-proxy", name: "op-proxy", authType: "api_key" }],
			() => {},
			() => {},
			() => ({ configured: true, source: "models_json_command" }),
		);

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("op-proxy");
		expect(output).toContain("✓ command in models.json");
		expect(output).not.toContain("unconfigured");
	});
});
