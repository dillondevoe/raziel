# Third-party licenses

Raziel itself is MIT-licensed (see [LICENSE](LICENSE)). This file lists its **direct**
dependencies, from `package.json` / `bun.lock`, with the license each declares in its installed
`package.json` (versions as locked). Checked 2026-10-04 against a `bun install` tree.

| Package | Locked version | Kind | License | Copyright holder / author |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | 0.122.0 | runtime | MIT | Anthropic (LICENSE file shipped in package) |
| `@earendil-works/pi-ai` | 0.84.4 | runtime | MIT | Mario Zechner |
| `@earendil-works/pi-tui` | 0.84.4 | runtime | MIT | Mario Zechner |
| `@types/bun` | 1.4.0 | dev | MIT | (LICENSE file shipped in package) |
| `typescript` | 7.0.2 | dev | Apache-2.0 | Microsoft Corp. |

## Notes

- **pi-ai / pi-tui licence text.** The published npm tarballs of `@earendil-works/pi-ai` and
  `pi-tui` contain no `LICENSE` file; they declare `"license": "MIT"` in `package.json` and
  pi-ai's README says "MIT". The upstream repository `earendil-works/pi` carries an MIT `LICENSE`
  ("Copyright (c) 2025 Mario Zechner"), which GitHub's license API reports as `MIT`. Anyone
  redistributing these packages should include that notice.
- **`@earendil-works/pi-telemetry`** (0.84.4, MIT, Mario Zechner) is a transitive dependency of
  pi-ai (not a direct one). It contains only telemetry type contracts, a no-op context and an
  in-memory recorder; see the PR that added this file for the source review. Raziel does not
  import it and does not pass a telemetry context to pi-ai.
- **Transitive dependencies.** The installed tree (including nested copies) holds about 100
  packages: MIT (41), Apache-2.0 (46, mostly the AWS SDK / Smithy pulled in by pi-ai's Bedrock
  support), BSD-3-Clause (11, `@protobufjs/*`), Unlicense (1, `fast-sha256`), 0BSD (1, `tslib`).
  Regenerate the full list from `node_modules/*/package.json`; it is not itemised here.
- Licenses are as declared by each package's metadata, not independently audited legal advice.
