// Removes the magic_link_tokens table. The magic-link flow was scrapped in
// favour of email/password + Google OAuth (see Milestone-1 Fase 3 rewrite).

export const name = '0003_drop_magic_link';

export const sql = `
DROP TABLE IF EXISTS magic_link_tokens;
`;
