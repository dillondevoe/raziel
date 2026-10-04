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

Raziel records every event of a session (prompts, model output, tool calls and their results,
file contents read, command output) to `~/.raziel/sessions/<id>.jsonl` (or under `$RAZIEL_HOME`).
These logs are **plaintext and unredacted**. They may contain API keys, tokens, passwords,
source code, and personal data that appeared in a file, a command's output, or a prompt.

Treat session logs as sensitive. Do not attach them to issues, commit them, sync them to shared
storage, or share them without reviewing them first. Delete logs you no longer need. Redaction
is not implemented.

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
