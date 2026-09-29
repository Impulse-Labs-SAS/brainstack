// The HTML a note body may carry into the preview.
//
// Notes accept raw HTML (`rehype-raw`), and a note is not always written by
// the person reading it: anyone with write access to a shared folder authors
// what its other members open. Unsanitised, `<img src=x onerror=…>` in a note
// runs script in the reader's session — enough to read their notes or mint an
// API key. So every note is cut down to GitHub's allowlist before it renders,
// the same set of tags and attributes a README on github.com gets.
//
// The two additions are our own URL schemes. `remarkWikilinks` turns
// `[[Note]]` into `wikilink://Note` and `![[file]]` into `embed://file`, and
// the `a` / `img` component overrides resolve them afterwards; without these
// entries the sanitiser would drop the URL and every wikilink with it.
//
// And one removal: GitHub's `user-content-` prefix on ids. remark-rehype
// already prefixes footnote ids, so the sanitiser prefixed them twice and left
// every footnote link pointing at nothing; it would also break `#anchor` links
// to ids written by hand. The prefix guards against DOM clobbering, and no code
// in this app looks elements up by id or name.

import { defaultSchema, type Options } from 'rehype-sanitize';

export const noteSanitizeSchema: Options = {
  ...defaultSchema,
  clobberPrefix: '',
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'wikilink'],
    src: [...(defaultSchema.protocols?.src ?? []), 'embed'],
  },
};
