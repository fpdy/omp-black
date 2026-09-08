# omp-black

Use your Claude Max (or Pro) subscription with [Oh My Pi](https://omp.sh).

`omp-black` is an unofficial OMP plugin that, on **OMP 17.2.x**, nudges Anthropic OAuth requests toward Claude Code **2.1.258 / `sdk-cli`** request conventions so subscription routing can apply. It does **not** replace OMP's Anthropic transport.

On **OMP 18+** the host already emits a Claude Code CLI fingerprint (`2.1.257` / `cli`). The plugin loads and leaves those requests unchanged, so it does not mix `sdk-cli` billing with a CLI system prompt.

## Install

Requires OMP **17.2.12+**. Rewrite runs only on **17.2.12–17.x**. 18 and newer load as a no-op.

```sh
omp plugin install github:fpdy/omp-black
# or from a local checkout
omp plugin link .
```

Then use OMP's normal Anthropic login:

```text
/login anthropic
```

## What it changes

OMP 17.2.x sends Anthropic OAuth traffic with a Cowork-style Claude fingerprint (`2.1.220` / `claude-desktop`) and patches the billing `cch` attestation on the wire. On that host this plugin adjusts the subscription-facing surface:

| Surface | OMP 17.2.x | OMP 18+ |
|---|---|---|
| `User-Agent` | Force `claude-cli/2.1.258 (external, sdk-cli)` | Unchanged (host CLI UA) |
| Billing system block | Rewrite Cowork `cc_version` / `cc_entrypoint` to `2.1.258` / `sdk-cli`, keep `cch=00000` | Unchanged (`cli` billing is not rewritten) |
| `metadata.user_id` | When rewriting, and `~/.claude.json` (or `CLAUDE_CONFIG_DIR`) has Claude Code identity, prefer that `device_id` + `account_uuid` | Unchanged |
| API-key payloads | Billing rewrite skipped (no Cowork block) | Unchanged |
| API-key `User-Agent` | Also receives the SDK-CLI UA (host cannot scope headers to OAuth) | Unchanged |
| Non-Anthropic providers | Untouched | Untouched |
| `cch` algorithm | Still OMP's built-in in-place attestor | Host attestor only |

Credential storage, OAuth refresh, tools, retries, streaming, and usage accounting stay in OMP.

## Identity discovery

No identity environment variables are required. On 17.x, when Claude Code state exists and the payload is being rewritten, omp-black reads the installation ID and account UUID from `~/.claude.json` in memory and merges them into request metadata. It does not copy, print, or persist those values. Routing still runs when that optional metadata is unavailable.

## Verify

```sh
npm ci --ignore-scripts
npm run check
```

Tests use fake transports only. They never make provider requests and require no credentials.

## Status and terms

This project is unofficial and is not affiliated with or endorsed by Anthropic or the Oh My Pi project. Users must provide their own valid account credentials and determine whether use complies with applicable service terms. The compatibility mechanism is version-specific and must be revalidated when Claude Code or OMP changes.

No OAuth tokens, identifiers, captures, or private Claude state are included in the package. Distributed under the MIT license; see [`LICENSE`](LICENSE). Security reporting and secret-handling notes are in [`SECURITY.md`](SECURITY.md).

The retained `patches/`, `install.sh`, and binary build scripts under this repository are a legacy Pi 0.84.1 standalone path and are **not** used by the OMP plugin.
