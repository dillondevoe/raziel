# Security policy

Raziel is pre-alpha software. Read this before running it.

## Supported versions

Only the `main` branch is supported. There are no tagged releases yet; fixes land on `main`.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue or pull request for an
undisclosed vulnerability, and do not send reports by email.

Include what you found, how to reproduce it, and the commit you tested. This is a
volunteer-maintained project; there is no guaranteed response time.

## Session logs are sensitive

Raziel appends each turn of a session (your prompts, the model's replies, every tool call, its
approval decision and its result, which includes file contents read, command output and fetched
pages, plus errors and token usage) to `~/.raziel/sessions/<id>.jsonl` (or under `$RAZIEL_HOME`).
The file is created owner-only (`0600`) in an owner-only (`0700`) directory (`src/session.ts`).
These logs are **plaintext and unredacted**: terminal control sequences are stripped from tool
output, nothing else is. They may contain API keys, tokens, passwords,
source code, and personal data that appeared in a file, a command's output, or a prompt.

Standing approval rules (`~/.raziel/rules.json`) are written the same way: the file `0600`, and
a directory created to hold it `0700` (`src/rules.ts`). An existing directory's mode is left as
it is.

Treat session logs as sensitive. Do not attach them to issues, commit them, sync them to shared
storage, or share them without reviewing them first. Delete logs you no longer need. Redaction
is not implemented.

## What the tools can reach

Every tool call is risk-classed (`src/risk.ts`) and gated by `src/approvals.ts`; see the README
section "What Raziel will and will not do without asking". The workspace is the directory you
start Raziel in. The limits each tool enforces itself:

- **Files** (`read_file`, `write_file`, `edit_file`, `glob`, `grep`; `src/tools/files.ts`,
  `src/tools/search.ts`): every path must resolve inside the workspace after following symlinks
  (`src/tools/workspace.ts`); a path that escapes is classed critical and refused without asking.
  `write_file` will not overwrite an existing file unless the call says `overwrite: true`;
  `edit_file` replaces exactly one exact match or fails. `grep` reads at most 200 files per call.
  Results are capped at 64,000 characters.
- **Commands** (`run_command`, `src/tools/exec.ts`): an argv array, never a shell string; the
  working directory must be inside the workspace. **The command itself is not contained**: it runs
  as you and can read or change anything you can. Environment variables named like secrets
  (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `AWS_*`, `GH_*`, `GITHUB_*`, `OPENAI_*`, `NPM_*`)
  are removed from its environment. It is killed after 30 seconds, or at once when you press
  Ctrl-C during the turn (the result then says it was interrupted); output is capped at 64,000
  characters.
- **Network** (`fetch`, `src/tools/fetch.ts`): `http` and `https` only; at most 3 redirects, all
  same-origin; 30-second timeout, and Ctrl-C during the turn aborts it at once; body capped at
  64,000 characters and prefixed
  `[UNTRUSTED FETCHED CONTENT]`. A URL naming `localhost` or a private, loopback or link-local IP
  address is classed high risk (always asked, never granted). The check reads the URL only: a
  public host name that resolves to a private address is classed as public.
- **Any tool** (`src/engine_tool_call.ts`): after the tool's own cap, the engine cuts any result
  longer than 65,000 characters to 64,000 plus `…[truncated]`. The built-in tools' capped output
  (64,000 characters plus a short marker, prefix or notice) stays under that, so this only bites
  on a tool that does not cap itself.
- **Model API keys**: the Anthropic door takes a console API key only; a subscription token
  (`sk-ant-oat…`) is refused when the provider is built (`src/providers/anthropic.ts`).

## Risk, warranty, and liability

Raziel is an agent: it sends your input to a model and then executes commands and edits files on
your machine on the model's behalf. The approval prompts and per-launch grants reduce that risk;
they are **not a sandbox**, and a model (or content it reads, such as a web page or file) can
produce harmful commands. You run Raziel entirely at your own risk, and you are responsible for
what you approve or grant, for the credentials you give it, and for the models and providers you
connect it to.

The software is provided "as is", without warranty of any kind, express or implied, and the
authors and contributors are not liable for any damage, data loss, cost, or other claim arising
from its use, as set out in the [MIT License](LICENSE).
