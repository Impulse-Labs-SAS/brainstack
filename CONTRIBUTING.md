# Contributing to BrainStack

Thanks for taking the time. BrainStack is maintained by [Impulse Labs](https://impulselabs.dev), a small
team — which shapes how contributions work here.

## Issues are open to everyone

Found a bug, want a feature, or have a question? [Open an issue](https://github.com/Impulse-Labs-SAS/brainstack/issues).

For a **bug**, include:

- the commit or version you are running, and how (Docker, Netlify, local dev);
- the steps that reproduce it, what you expected, and what happened instead;
- relevant logs — with tokens, keys and email addresses removed.

For a **feature**, describe the problem you are trying to solve before the solution you have in mind. The
problem is what we can weigh; there is often more than one way to solve it.

## Security vulnerabilities are not issues

Do not report a vulnerability in a public issue. Use **Report a vulnerability** under the repository's
[Security tab](https://github.com/Impulse-Labs-SAS/brainstack/security) instead — only the maintainers see it.

## Code starts with an issue, not a pull request

Review time is the scarcest thing this project has. So:

1. Open an issue describing the change, or comment on an existing one saying you would like to take it.
2. Wait for a maintainer to agree on the approach.
3. Then open the pull request, linking the issue.

Pull requests that skip the first two steps may be closed without review. It is not that they are unwelcome —
it is that a change nobody agreed on is the most expensive kind to review, and the likeliest to be declined
after you have done the work.

Typo and documentation fixes are the exception: send those straight away.

## Working on the code

You need Node 20.10+ and pnpm 10.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Those four are exactly what CI runs, so a pull request that passes them locally will pass there. The tests need
no database: they run on PGlite, a real Postgres running in process. To run the app itself you need a
`DATABASE_URL` — see [`.env.example`](.env.example).

Before you write code, read the **Non-negotiable rules** in [CLAUDE.md](CLAUDE.md). They are written for AI
assistants, but they bind everyone: most of them exist because breaking them once gave someone access they should
not have had, or took it away from someone who should.

A pull request is ready when:

- it does one thing, and its commits follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`);
- a behaviour change comes with a test, and a bug fix with a test that failed before the fix;
- `pnpm format` has been run.

## Contributor License Agreement

Before we can merge your first pull request, you will be asked to sign our
[Contributor License Agreement](CLA.md) (CLA).
You keep the copyright of what you contribute; the CLA grants Impulse Labs the right to also distribute it under
terms other than the AGPL — which is what lets us offer BrainStack as a hosted service, or under a commercial
license, without having to ask every contributor again.

## License

BrainStack is licensed under the [GNU Affero General Public License v3.0](LICENSE). By contributing, you agree
that your contribution is licensed under it too, in addition to the rights granted in the CLA.
