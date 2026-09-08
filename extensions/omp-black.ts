import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { VERSION } from "@oh-my-pi/pi-coding-agent";
import {
	adjustOmpClaudeCodePayload,
	CLAUDE_CODE_USER_AGENT,
	discoverClaudeCodeIdentity,
	isSupportedOmpVersion,
	SUPPORTED_OMP_MIN_VERSION,
} from "../src/claude-code-protocol.ts";

/**
 * Route Anthropic OAuth traffic toward Claude Code subscription request shape.
 *
 * Strategy (OMP 17.2.x constraints):
 * - Cannot wrap built-in `anthropic-messages` stream (reserved custom API name).
 * - OMP already injects Cowork OAuth fingerprint + in-place `cch` attestation.
 * - This extension only:
 *   1. Forces Claude Code SDK-CLI User-Agent via provider header override
 *      (OMP honors caller UA when it already starts with `claude-cli`).
 *   2. Rewrites the billing system block to CC 2.1.258 / `sdk-cli`.
 *   3. Prefers real `~/.claude.json` identity in `metadata.user_id` when present.
 * - Leaves OMP's cch attestor alone (byte-anchored); do not re-serialize bodies.
 */
export default function ompBlack(pi: ExtensionAPI): void {
	if (!isSupportedOmpVersion(VERSION)) {
		console.warn(
			`[omp-black] host OMP ${VERSION} is outside the supported range (>= ${SUPPORTED_OMP_MIN_VERSION}, major ${SUPPORTED_OMP_MIN_VERSION.split(".")[0]}). Continuing anyway.`,
		);
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
