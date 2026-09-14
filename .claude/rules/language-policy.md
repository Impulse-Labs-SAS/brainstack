# Language Policy

BrainStack is open source. Everything committed to this repository is written in **English**, so that
anyone who can read the code can read everything around it.

## English, always

- Code identifiers, comments, log messages, error messages and error codes
- User-facing strings: UI labels, placeholders, toasts, API error messages, emails
- `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/`, `.env.example` comments
- `.claude/` — rules, skills, commands, agents
- `packages/skill/INSTRUCTIONS.md` — it is served to every user's AI assistant
- Commit messages, branch names, PR titles and bodies, issue comments

## Not governed by this file

- The conversation with the person you are working with: answer in the language they write in.
- The **content** of a user's notes. BrainStack stores whatever language people write in; nothing in
  the code may assume one.

## Existing debt

Some user-facing strings and docs predate this policy and are in Spanish (a few service error
messages, `docs/*-design.md`), and full-text search stems Spanish only. Do not add more. When you
touch one of those strings for another reason, translate it in the same change; do not open a sweep
that rewrites them all in a branch with another purpose.
