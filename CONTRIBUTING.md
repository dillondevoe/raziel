# Contributing

Thanks for helping. Raziel is pre-alpha; the owner reviews and merges every pull request.

## Pull requests

- Keep them small and single-purpose. Several small PRs beat one large one.
- Branch from `main`; open the PR against `main`.
- Explain what changed, why, and how you verified it.
- Do not report security issues in a PR or public issue; see [SECURITY.md](SECURITY.md).

## Before you push

```sh
bun install
bun test
bun run typecheck
```

Both must pass. Add or update a test with any behavior change.

## Sign-off (DCO)

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/). Add it with:

```sh
git commit -s
```

By contributing you agree your work is licensed under the repository's [MIT License](LICENSE).

## Never commit

Secrets, session logs (`~/.raziel/sessions`), or personal data. Session logs are plaintext and
unredacted; see [SECURITY.md](SECURITY.md).
