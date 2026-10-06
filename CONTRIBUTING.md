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

## Code is written by the team

BrainStack is open source, but not open to code contributions. Every line in this repository is written by the
Impulse Labs team, so the copyright of the whole codebase stays in one place and the project's licensing stays
ours to decide.

That is why we do not accept pull requests from outside the team. One opened anyway is closed with a pointer
back here. It is not that your work is unwelcome. A merged pull request would make you a copyright holder of
BrainStack, and we would rather not ask anyone to sign their rights away.

Your ideas are welcome, though, and they are how the project moves. If you have found a bug or know how to fix
it, open an issue and describe the problem and the fix you have in mind. We weigh it, and if we take it on, we
write the code ourselves. Please do not paste code meant for the repository into an issue; describe it instead.

You are free to fork BrainStack and change it under the terms of the license.

## Running it from source

You need Node 20.10+ and pnpm 10.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Those four are exactly what CI runs. The tests need no database: they run on PGlite, a real Postgres running
in process. To run the app itself you need a `DATABASE_URL` — see [`.env.example`](.env.example).

Before you change the code in your fork, read the **Non-negotiable rules** in [CLAUDE.md](CLAUDE.md). Most of
them exist because breaking them once gave someone access they should not have had, or took it away from
someone who should.

## License

BrainStack is copyright Impulse Labs SAS and licensed under the
[GNU Affero General Public License v3.0](LICENSE).
