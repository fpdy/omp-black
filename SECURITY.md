# Security

## Secrets

Do not commit or attach any of the following:

- Anthropic OAuth access or refresh tokens;
- `CLAUDE_CODE_DEVICE_ID` values;
- `CLAUDE_CODE_ACCOUNT_UUID` values;
- intercepted request captures;
- extracted private prompts or local Claude state.

The OMP plugin reads matching identity values from Claude Code's local state
(`~/.claude.json` or `CLAUDE_CONFIG_DIR`) in memory when available. It does not
copy, log, or persist them. No identity environment variables are required for
the plugin path. CI and package tests use fake transports only: they never read
local Claude state, perform a live provider request, or require provider secrets.

## Trust boundary

omp-black only adjusts Anthropic OAuth request surface area for subscription
routing:

- may set a Claude Code SDK-CLI `User-Agent`;
- may rewrite the billing system block (`cc_version` / `cc_entrypoint`) while
  leaving OMP's in-place `cch` attestor alone;
- may merge optional `device_id` / `account_uuid` into request metadata when
  local Claude Code state is present.

It does not replace OMP credential storage, OAuth refresh, API-key requests,
non-Anthropic providers, tools, retries, streaming, or usage accounting. It does
not reimplement the `cch` algorithm.

## Plugin verification

The supported distribution path is the OMP plugin (Git install or local link):

```sh
npm ci --ignore-scripts
npm run check
```

## Legacy standalone verification

The retained `patches/`, `install.sh`, `launcher.sh`, and binary build scripts
are a legacy Pi 0.84.1 standalone path inherited from pi-black. They are **not**
used by the OMP plugin. If you build or install that path anyway:

Every standalone release is expected to contain `SHA256SUMS`. Verify an extracted
download before use:

```sh
sha256sum -c SHA256SUMS
```

On macOS, use `shasum -a 256` if GNU `sha256sum` is unavailable. The standalone
installer verifies its selected archive and launcher against this manifest. On
later interactive starts, the launcher compares the installed archive digest
with the latest release and verifies a downloaded installer before offering to
apply it. Network or update failures do not block the installed binary.

The checksum manifest and assets are served by the same GitHub Release;
checksums detect corruption but are not an independent signature. Release
binaries produced by Bun are not Apple-notarized unless release notes explicitly
state otherwise. The retained patch path may also read explicit
`CLAUDE_CODE_DEVICE_ID` / `CLAUDE_CODE_ACCOUNT_UUID` runtime environment values;
never commit those values.

## Reporting

Use a private GitHub security advisory for vulnerabilities that could expose
credentials or identifiers in omp-black. Do not include live credentials or
captures in reports.
