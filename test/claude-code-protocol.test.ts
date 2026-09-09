import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	adjustOmpClaudeCodePayload,
	buildClaudeCodeBillingHeader,
	CLAUDE_CODE_VERSION,
	claudeCodeVersionFingerprint,
	claudeCodeVersionFingerprintFromPrompt,
	discoverClaudeCodeIdentity,
	isSupportedOmpVersion,
	parseClaudeCodeIdentity,
	patchClaudeCodeCch,
	transformClaudeCodePayload,
	xxHash64,
} from "../src/claude-code-protocol.ts";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];
const promptMessages = (prompt: string): Message[] => [
	{ role: "user", content: prompt, timestamp: 1 },
];
const deviceId = "f".repeat(64);
const accountUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Claude Code protocol", () => {
	it("implements standard XXH64 vectors", () => {
		expect(xxHash64(encoder.encode("")).toString(16)).toBe("ef46db3751d8e999");
		expect(xxHash64(encoder.encode("hello")).toString(16)).toBe(
			"26c7827d889f6da3",
		);
	});

	it("reproduces the recovered cc_version prompt fingerprint", async () => {
		expect(
			await claudeCodeVersionFingerprint(
				promptMessages("Reply with exactly: PROBE_OK"),
			),
		).toBe("01c");
		expect(
			await buildClaudeCodeBillingHeader(
				promptMessages("Reply with exactly: PROBE_OK"),
			),
		).toBe(
			`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.01c; cc_entrypoint=sdk-cli; cch=00000;`,
		);
	});

	it("discovers and validates identity from Claude Code state without exposing it", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-black-"));
		temporaryDirectories.push(root);
		const path = join(root, ".claude.json");
		await writeFile(
			path,
			JSON.stringify({ userID: deviceId, oauthAccount: { accountUuid } }),
		);

		expect(await discoverClaudeCodeIdentity({}, path)).toEqual({
			deviceId,
			accountUuid,
		});
		expect(
			parseClaudeCodeIdentity({ userID: "bad", oauthAccount: { accountUuid } }),
		).toBeUndefined();
	});

	it("builds billing and Agent SDK blocks first and adds discovered identity", async () => {
		const payload = await transformClaudeCodePayload(
			{
				model: "claude-opus-5",
				messages: [],
				max_tokens: 64000,
				stream: true,
				system: [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
					},
					{
						type: "text",
						text: "Pi system",
						cache_control: { type: "ephemeral" },
					},
				],
			},
			promptMessages("Reply with exactly: PROBE_OK"),
			"11111111-2222-4333-8444-555555555555",
			{ deviceId, accountUuid },
		);
		const system = payload.system as Array<Record<string, unknown>>;
		expect(system[0]).toEqual({
			type: "text",
			text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.01c; cc_entrypoint=sdk-cli; cch=00000;`,
		});
		expect(system[1]).toEqual({
			type: "text",
			text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
		});
		expect(system[2]).toEqual({
			type: "text",
			text: "Pi system",
			cache_control: { type: "ephemeral" },
		});
		expect(payload.metadata).toEqual({
			user_id: JSON.stringify({
				device_id: deviceId,
				account_uuid: accountUuid,
				session_id: "11111111-2222-4333-8444-555555555555",
			}),
		});
	});

	it("does not duplicate blocks when already transformed", async () => {
		const first = await transformClaudeCodePayload(
			{
				model: "claude-opus-5",
				messages: [],
				max_tokens: 1,
				stream: true,
				system: [{ type: "text", text: "Pi system" }],
			},
			promptMessages("hello"),
			undefined,
			undefined,
		);
		const second = await transformClaudeCodePayload(
			first,
			promptMessages("hello"),
			undefined,
			undefined,
		);
		expect(second.system).toEqual(first.system);
	});

	it("omits identity metadata when Claude Code state is unavailable", async () => {
		const payload = await transformClaudeCodePayload(
			{ model: "claude-opus-5", messages: [], max_tokens: 1, stream: true },
			promptMessages("hello"),
			"11111111-2222-4333-8444-555555555555",
			undefined,
		);
		expect(payload).not.toHaveProperty("metadata");
	});

	it("reproduces the recovered normalized-body checksum", () => {
		const body =
			'{"model":"claude-opus-5","messages":[{"role":"user","content":"A"}],"max_tokens":64000,"stream":true,"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=00000;"}]}';
		expect(patchClaudeCodeCch(body)).toContain("cch=7ba34");
	});

	it("patches only the first billing block despite placeholder and nested-field collisions", () => {
		const body = {
			model: "claude-opus-5",
			messages: [
				{
					role: "user",
					content: "cch=00000",
					model: "nested-model",
					max_tokens: 7,
				},
			],
			max_tokens: 64000,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=00000;",
				},
				{ type: "text", text: "fake cch=00000" },
			],
			tools: [
				{
					name: "probe",
					description: "model max_tokens cch=00000",
					input_schema: { type: "object" },
				},
			],
		};
		const patched = JSON.parse(
			patchClaudeCodeCch(JSON.stringify(body)),
		) as typeof body;
		expect(patched.system[0].text).toMatch(/cch=[0-9a-f]{5};$/u);
		expect(patched.system[0].text).not.toContain("cch=00000");
		expect(patched.messages[0]).toEqual(body.messages[0]);
		expect(patched.system[1]).toEqual(body.system[1]);
		expect(patched.tools).toEqual(body.tools);
	});

	it("leaves an already patched billing value unchanged", () => {
		const body = JSON.stringify({
			model: "claude-opus-5",
			messages: [],
			max_tokens: 1,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.224.000; cc_entrypoint=sdk-cli; cch=abc12;",
				},
			],
		});
		expect(patchClaudeCodeCch(body)).toBe(body);
	});

	it("activates rewrite only on OMP 17.2.12–17.x", () => {
		expect(isSupportedOmpVersion("17.2.12")).toBe(true);
		expect(isSupportedOmpVersion("17.3.0")).toBe(true);
		expect(isSupportedOmpVersion("17.2.11")).toBe(false);
		expect(isSupportedOmpVersion("16.9.9")).toBe(false);
		expect(isSupportedOmpVersion("18.0.0")).toBe(false);
		expect(isSupportedOmpVersion("18.1.14")).toBe(false);
	});

	it("fingerprints only the first text block of the first user message", async () => {
		const firstBlock = "Hi";
		const expected = await claudeCodeVersionFingerprintFromPrompt(firstBlock);
		expect(
			await claudeCodeVersionFingerprint([
				{
					role: "user",
					content: [
						{ type: "text", text: firstBlock },
						{ type: "text", text: "Reply with exactly: PROBE_OK" },
					],
					timestamp: 1,
				},
			]),
		).toBe(expected);
		expect(expected).not.toBe(
			await claudeCodeVersionFingerprintFromPrompt(
				`${firstBlock}Reply with exactly: PROBE_OK`,
			),
		);
	});
});

describe("OMP payload adjuster", () => {
	it("rewrites Cowork billing text to SDK-CLI without touching structure", async () => {
		const payload = {
			model: "claude-sonnet-4-5",
			messages: [
				{ role: "user", content: "Reply with exactly: PROBE_OK" },
			],
			max_tokens: 1024,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.220.abc; cc_entrypoint=claude-desktop; cch=00000;",
				},
				{
					type: "text",
					text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
				},
				{ type: "text", text: "OMP system", cache_control: { type: "ephemeral" } },
			],
			metadata: {
				user_id: JSON.stringify({
					device_id: "a".repeat(64),
					session_id: "11111111-2222-4333-8444-555555555555",
				}),
			},
		};

		const adjusted = (await adjustOmpClaudeCodePayload(payload, {
			deviceId,
			accountUuid,
		})) as typeof payload;

		expect(adjusted.system[0].text).toBe(
			`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.01c; cc_entrypoint=sdk-cli; cch=00000;`,
		);
		expect(adjusted.system[1]).toEqual(payload.system[1]);
		expect(adjusted.system[2]).toEqual(payload.system[2]);
		expect(adjusted.metadata.user_id).toBe(
			JSON.stringify({
				device_id: deviceId,
				account_uuid: accountUuid,
				session_id: "11111111-2222-4333-8444-555555555555",
			}),
		);
	});

	it("leaves API-key payloads unchanged", async () => {
		const payload = {
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 16,
			system: [{ type: "text", text: "plain system" }],
		};
		const adjusted = await adjustOmpClaudeCodePayload(payload, {
			deviceId,
			accountUuid,
		});
		expect(adjusted).toBe(payload);
		expect(adjusted).toEqual(payload);
	});

	it("keeps cch placeholder so host attestor can still patch", async () => {
		const payload = {
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello world" }],
			max_tokens: 16,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.220.000; cc_entrypoint=claude-desktop; cch=00000;",
				},
			],
		};
		const adjusted = (await adjustOmpClaudeCodePayload(
			payload,
			undefined,
		)) as typeof payload;
		expect(adjusted.system[0].text).toContain("cch=00000");
		expect(adjusted.system[0].text).toContain("cc_entrypoint=sdk-cli");
	});

	it("rewrites Cowork billing when the entrypoint is last or tightly spaced", async () => {
		const fingerprint = await claudeCodeVersionFingerprintFromPrompt("hello");
		const expected = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=sdk-cli; cch=00000;`;
		for (const text of [
			"x-anthropic-billing-header: cc_version=2.1.220.000; cc_entrypoint=claude-desktop",
			"x-anthropic-billing-header: cc_entrypoint=claude-desktop; cc_version=2.1.220.000; cch=00000;",
			"x-anthropic-billing-header: cc_version=2.1.220.000;cc_entrypoint=claude-desktop;cch=00000;",
		]) {
			const payload = {
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
				system: [{ type: "text", text }],
			};
			const adjusted = (await adjustOmpClaudeCodePayload(
				payload,
				undefined,
			)) as typeof payload;
			expect(adjusted.system[0].text).toBe(expected);
		}
	});

	it("leaves OMP 18 CLI billing and identity untouched", async () => {
		const payload = {
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "Reply with exactly: PROBE_OK" }],
			max_tokens: 1024,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.257.abc; cc_entrypoint=cli; cch=00000;",
				},
				{
					type: "text",
					text: "You are Claude Code, Anthropic's official CLI for Claude.",
					cache_control: { type: "ephemeral" },
				},
			],
			metadata: {
				user_id: JSON.stringify({
					device_id: "a".repeat(64),
					session_id: "11111111-2222-4333-8444-555555555555",
				}),
			},
		};
		const adjusted = await adjustOmpClaudeCodePayload(payload, {
			deviceId,
			accountUuid,
		});
		expect(adjusted).toBe(payload);
		expect(adjusted).toEqual(payload);
	});

	it("seeds Cowork billing from the first user text block only", async () => {
		const firstBlock = "Hi";
		const fingerprint =
			await claudeCodeVersionFingerprintFromPrompt(firstBlock);
		const payload = {
			model: "claude-sonnet-4-5",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: firstBlock },
						{ type: "text", text: "Reply with exactly: PROBE_OK" },
					],
				},
			],
			max_tokens: 16,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.220.000; cc_entrypoint=claude-desktop; cch=00000;",
				},
			],
		};
		const adjusted = (await adjustOmpClaudeCodePayload(
			payload,
			undefined,
		)) as typeof payload;
		expect(adjusted.system[0].text).toBe(
			`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=sdk-cli; cch=00000;`,
		);
	});
});
