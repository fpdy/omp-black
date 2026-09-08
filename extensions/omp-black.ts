import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { VERSION } from "@oh-my-pi/pi-coding-agent";
import {
	adjustOmpClaudeCodePayload,
	CLAUDE_CODE_USER_AGENT,
	discoverClaudeCodeIdentity,
	isSupportedOmpVersion,
	SUPPORTED_OMP_MAJOR,
	SUPPORTED_OMP_MIN_VERSION,
} from "../src/claude-code-protocol.ts";

/**
 * Route Anthropic OAuth traffic toward Claude Code subscription request shape.
 *
 * Strategy:
 * - Cannot wrap built-in `anthropic-messages` stream (reserved custom API name).
 * - OMP 17.2.x injects Cowork OAuth fingerprint + in-place `cch` attestation.
 *   This extension then:
 *   1. Forces Claude Code SDK-CLI User-Agent via provider header override
 *      (OMP honors caller UA when it already starts with `claude-cli`).
 *   2. Rewrites Cowork billing (`claude-desktop`) to CC 2.1.258 / `sdk-cli`.
 *   3. Prefers real `~/.claude.json` identity in `metadata.user_id` when present.
 * - OMP 18+ already emits the CLI fingerprint; do not rewrite or override UA.
 * - Leaves OMP's cch attestor alone (byte-anchored); do not re-serialize bodies.
 *
 * The User-Agent header override applies to every Anthropic model on 17.x,
 * including API-key requests. Payload rewrite stays billing-gated (OAuth).
 */
export default function ompBlack(pi: ExtensionAPI): void {
	if (!isSupportedOmpVersion(VERSION)) {
		console.warn(
			`[omp-black] host OMP ${VERSION} is not a Cowork rewrite target (>= ${SUPPORTED_OMP_MIN_VERSION}, major ${SUPPORTED_OMP_MAJOR} only). Leaving requests unchanged.`,
		);
		return;
	}

	const identityPromise = discoverClaudeCodeIdentity();

	// Provider header override reaches buildAnthropicHeaders as modelHeaders.
	// OAuth path keeps claude-cli* User-Agents instead of the Cowork default.
	pi.registerProvider("anthropic", {
		headers: {
			"User-Agent": CLAUDE_CODE_USER_AGENT,
		},
	});

	pi.on("before_provider_request", async (event) => {
		const identity = await identityPromise;
		return adjustOmpClaudeCodePayload(event.payload, identity);
	});
}
