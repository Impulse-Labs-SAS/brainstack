// Root tRPC router. The web app talks to the server exclusively through this
// router; MCP clients go through the dedicated MCP transports. Both share the
// same underlying services, so behaviour stays consistent.

import { TRPCError, initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';

import { listBacklinksSafely } from '../lib/backlinks.js';
import { AppError } from '../lib/errors.js';
import { MAX_TREE_DEPTH } from '../services/NoteService.js';

import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      appCode: error.cause instanceof AppError ? error.cause.code : (shape.data.code as string),
    },
  }),
});

const requireUser = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'session required' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(requireUser);

const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      const trpcCode =
        err.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : err.code === 'ALREADY_EXISTS'
            ? 'CONFLICT'
            : err.code === 'UNAUTHORIZED'
              ? 'UNAUTHORIZED'
              : err.code === 'FORBIDDEN'
                ? 'FORBIDDEN'
                : err.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : 'INTERNAL_SERVER_ERROR';
      throw new TRPCError({ code: trpcCode, message: err.message, cause: err });
    }
    throw err;
  }
};

const FrontmatterInput = z.record(z.string(), z.unknown()).optional();

/** A logged-in context: `protectedProcedure` has already rejected the alternative. */
type AuthedContext = TrpcContext & { user: NonNullable<TrpcContext['user']> };

/**
 * Which vault a request is about.
 *
 * Almost every request means "mine", so `ownerId` is optional and defaults to
 * the caller. Naming somebody else's id is how a shared folder is addressed:
 * paths are always relative to that person's root, never to yours.
 */
const OwnerInput = z.string().min(1).optional();
const ownerOf = (ctx: AuthedContext, ownerId?: string): string => ownerId ?? ctx.user.id;

/**
 * The write guard, shared by every mutation that takes a path.
 *
 * Two questions, not one. First: may this user write here — which since the
 * permission column can be yes in somebody else's vault.
 *
 * Second, and only when writing into your own vault: does the path name a
 * folder somebody shared with you? Then it is ambiguous — "impulse-labs/x.md"
 * could mean your folder or theirs — and it used to be resolved silently in
 * favour of yours, creating a private copy of a shared folder. Saying `ownerId`
 * removes the ambiguity, which is why the check does not apply once it is
 * given.
 *
 * `ctx.sharedRoots()` is memoised per request, so a move checking both of its
 * ends still costs a single query.
 */
const assertWritable = async (
  ctx: AuthedContext,
  ownerId: string,
  path: string,
  /** True when the request named an owner. See below. */
  ownerWasNamed: boolean,
): Promise<void> => {
  await ctx.sharing.assertCanWrite(ctx.user.id, ownerId, path);
  if (!ownerWasNamed) {
    await ctx.sharing.assertNotShadowingShare(ctx.user.id, path, await ctx.sharedRoots());
  }
};

export const appRouter = t.router({
  auth: t.router({
    me: t.procedure.query(({ ctx }) => ({ user: ctx.user })),
    logout: protectedProcedure.mutation(() => ({ ok: true })),
    updateProfile: protectedProcedure
      .input(z.object({ displayName: z.string().max(120) }))
      .mutation(async ({ ctx, input }) =>
        wrap(async () => ({
          user: await ctx.auth.updateProfile(ctx.user.id, { displayName: input.displayName }),
        })),
      ),
  }),
  notes: t.router({
    get: protectedProcedure
      .input(z.object({ path: z.string().min(1), ownerId: OwnerInput }))
      .query(async ({ ctx, input }) =>
        wrap(async () => {
          const owner = ownerOf(ctx, input.ownerId);
          await ctx.sharing.assertCanRead(ctx.user.id, owner, input.path);
          return ctx.notes.get(owner, input.path);
        }),
      ),
    list: protectedProcedure
      .input(
        z
          .object({
            folder: z.string().optional(),
            tag: z.string().optional(),
            facetKey: z.string().optional(),
            facetValue: z.string().optional(),
            status: z.string().optional(),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) => {
        const { facetKey, facetValue, ...rest } = input ?? {};
        const facet = facetKey && facetValue ? { key: facetKey, value: facetValue } : undefined;
        return ctx.notes.list(ctx.user.id, { ...rest, ...(facet ? { facet } : {}) });
      }),
    create: protectedProcedure
      .input(
        z.object({
          path: z.string().min(1),
          content: z.string(),
          frontmatter: FrontmatterInput,
          ownerId: OwnerInput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          const owner = ownerOf(ctx, input.ownerId);
          await assertWritable(ctx, owner, input.path, input.ownerId !== undefined);
          return ctx.notes.create(owner, input.path, input.content, input.frontmatter);
        }),
      ),
    update: protectedProcedure
      .input(z.object({ path: z.string().min(1), content: z.string(), ownerId: OwnerInput }))
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          const owner = ownerOf(ctx, input.ownerId);
          await assertWritable(ctx, owner, input.path, input.ownerId !== undefined);
          return ctx.notes.update(owner, input.path, input.content);
        }),
      ),
    remove: protectedProcedure
      .input(
        z.object({
          path: z.string().min(1),
          recursive: z.boolean().optional(),
          ownerId: OwnerInput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          const owner = ownerOf(ctx, input.ownerId);
          await assertWritable(ctx, owner, input.path, input.ownerId !== undefined);
          return ctx.notes.remove(owner, input.path, { recursive: input.recursive });
        }),
      ),
    move: protectedProcedure
      .input(z.object({ from: z.string().min(1), to: z.string().min(1), ownerId: OwnerInput }))
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          // One owner for both ends: a move stays inside a single vault, and
          // both paths are read against the same root.
          const owner = ownerOf(ctx, input.ownerId);
          await assertWritable(ctx, owner, input.from, input.ownerId !== undefined);
          await assertWritable(ctx, owner, input.to, input.ownerId !== undefined);
          return ctx.notes.move(owner, input.from, input.to);
        }),
      ),
    /**
     * Move a note or folder into another person's vault.
     *
     * Separate from `move` because the permission question is different: you
     * must be allowed to take it from where it is *and* to put it where it is
     * going, and those are two different grants.
     */
    moveToOwner: protectedProcedure
      .input(
        z.object({
          from: z.string().min(1),
          fromOwnerId: OwnerInput,
          to: z.string().min(1),
          toOwnerId: z.string().min(1),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          const fromOwner = ownerOf(ctx, input.fromOwnerId);
          // Taking something out is a write on the source, not a read.
          await assertWritable(ctx, fromOwner, input.from, input.fromOwnerId !== undefined);
          await assertWritable(ctx, input.toOwnerId, input.to, true);
          return ctx.notes.moveAcrossVaults({
            fromOwnerId: fromOwner,
            fromPath: input.from,
            toOwnerId: input.toOwnerId,
            toPath: input.to,
          });
        }),
      ),
    createFolder: protectedProcedure
      .input(z.object({ path: z.string().min(1), ownerId: OwnerInput }))
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          const owner = ownerOf(ctx, input.ownerId);
          await assertWritable(ctx, owner, input.path, input.ownerId !== undefined);
          return ctx.notes.createFolder(owner, input.path);
        }),
      ),
    tree: protectedProcedure
      .input(
        z
          .object({
            path: z.string().optional(),
            depth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) =>
        wrap(() => ctx.notes.listTree(ctx.user.id, input?.path, input?.depth)),
      ),
    decisions: protectedProcedure
      .input(
        z
          .object({
            folder: z.string().optional(),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) => ctx.notes.listDecisions(ctx.user.id, input ?? {})),
    backlinks: protectedProcedure
      .input(z.object({ path: z.string().min(1), ownerId: OwnerInput }))
      .query(async ({ ctx, input }) => {
        const owner = ownerOf(ctx, input.ownerId);
        await ctx.sharing.assertCanRead(ctx.user.id, owner, input.path);
        // Not just `ctx.notes.listLinks`: that call is owner-scoped, not
        // permission-aware, and would name a backlink's source even when it
        // sits in a folder this caller was never granted.
        return listBacklinksSafely(ctx.user.id, owner, input.path, {
          notes: ctx.notes,
          crossOwner: ctx.crossOwner,
        });
      }),
    graph: protectedProcedure
      .input(z.object({ scope: z.enum(['mine', 'shared', 'all']).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const scope = input?.scope ?? 'mine';
        const sharedScopes =
          scope !== 'mine'
            ? (await ctx.sharedRoots()).map((r) => ({
                ownerId: r.ownerId,
                folderPath: r.folderPath,
              }))
            : [];
        return ctx.notes.graph(ctx.user.id, { sharedScopes });
      }),
    outboundLinks: protectedProcedure
      .input(z.object({ path: z.string().min(1), ownerId: OwnerInput }))
      .query(async ({ ctx, input }) => {
        const owner = ownerOf(ctx, input.ownerId);
        await ctx.sharing.assertCanRead(ctx.user.id, owner, input.path);
        // For your own notes, same as `linksForOwner`'s masking already does
        // for a shared one — an unreadable target comes back as unresolved
        // rather than naming a path outside the grant.
        return ctx.user.id === owner
          ? ctx.notes.listOutboundLinks(owner, input.path)
          : ctx.crossOwner.linksForOwner(ctx.user.id, owner, input.path);
      }),
    related: protectedProcedure
      .input(
        z.object({
          path: z.string().min(1),
          ownerId: OwnerInput,
          scope: z.enum(['mine', 'shared', 'all']).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const owner = ownerOf(ctx, input.ownerId);
        await ctx.sharing.assertCanRead(ctx.user.id, owner, input.path);
        const scope = input.scope ?? 'mine';
        const sharedScopes =
          scope !== 'mine'
            ? (await ctx.sharedRoots()).map((r) => ({
                ownerId: r.ownerId,
                folderPath: r.folderPath,
              }))
            : [];
        return ctx.notes.listRelated(owner, input.path, { sharedScopes, limit: input.limit });
      }),
    facetsForNote: protectedProcedure
      .input(z.object({ path: z.string().min(1), ownerId: OwnerInput }))
      .query(async ({ ctx, input }) => {
        const owner = ownerOf(ctx, input.ownerId);
        await ctx.sharing.assertCanRead(ctx.user.id, owner, input.path);
        return ctx.notes.listFacetsForNote(owner, input.path);
      }),
    facets: protectedProcedure
      .input(z.object({ key: z.string().optional() }).optional())
      .query(({ ctx, input }) => ctx.notes.listFacets(ctx.user.id, input?.key)),
    tags: protectedProcedure.query(({ ctx }) => ctx.notes.listTags(ctx.user.id)),
    getForOwner: protectedProcedure
      .input(z.object({ ownerId: z.string().min(1), path: z.string().min(1) }))
      .query(async ({ ctx, input }) =>
        wrap(() => ctx.crossOwner.getNote(ctx.user.id, input.ownerId, input.path)),
      ),
    treeForOwner: protectedProcedure
      .input(
        z.object({
          ownerId: z.string().min(1),
          path: z.string().min(1),
          depth: z.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
        }),
      )
      .query(async ({ ctx, input }) =>
        wrap(() => ctx.crossOwner.listTree(ctx.user.id, input.ownerId, input.path, input.depth)),
      ),
    linksForOwner: protectedProcedure
      .input(z.object({ ownerId: z.string().min(1), path: z.string().min(1) }))
      .query(({ ctx, input }) =>
        wrap(() => ctx.crossOwner.linksForOwner(ctx.user.id, input.ownerId, input.path)),
      ),
  }),
  search: t.router({
    query: protectedProcedure
      .input(
        z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
          scope: z.enum(['mine', 'shared', 'all']).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const scope = input.scope ?? 'mine';
        const includeMine = scope !== 'shared';
        const sharedScopes =
          scope !== 'mine'
            ? (await ctx.sharedRoots()).map((r) => ({
                ownerId: r.ownerId,
                folderPath: r.folderPath,
              }))
            : [];
        return ctx.search.search(ctx.user.id, input.query, {
          limit: input.limit,
          includeMine,
          sharedScopes,
        });
      }),
  }),
  sharing: t.router({
    listSharedWithMe: protectedProcedure.query(({ ctx }) =>
      ctx.sharing.enabled ? ctx.sharing.listSharedRoots(ctx.user.id) : [],
    ),
    listMyShares: protectedProcedure.query(({ ctx }) =>
      ctx.sharing.enabled ? ctx.sharing.listMyShares(ctx.user.id) : [],
    ),
    shareWithUser: protectedProcedure
      .input(
        z.object({
          folderPath: z.string().min(1),
          email: z.string().email(),
          permission: z.enum(['read', 'write']).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          if (!ctx.sharing.enabled) {
            throw new AppError('sharing no disponible en este deployment', 'NOT_FOUND', 404);
          }
          const target = await ctx.auth.findUserByEmail(input.email);
          if (!target) {
            // El flow con invitación por email/link entra en el paso 9.
            throw new AppError('user no encontrado; usar invitación', 'NOT_FOUND', 404);
          }
          const id = await ctx.sharing.grant({
            ownerId: ctx.user.id,
            sharedWithUserId: target.id,
            folderPath: input.folderPath,
            grantedBy: ctx.user.id,
            permission: input.permission,
          });
          return { id, sharedWithUserId: target.id, permission: input.permission ?? 'read' };
        }),
      ),
    revoke: protectedProcedure
      .input(
        z.object({
          folderPath: z.string().min(1),
          sharedWithUserId: z.string().min(1),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          if (!ctx.sharing.enabled) {
            throw new AppError('sharing no disponible en este deployment', 'NOT_FOUND', 404);
          }
          await ctx.sharing.revoke({
            ownerId: ctx.user.id,
            sharedWithUserId: input.sharedWithUserId,
            folderPath: input.folderPath,
          });
          return { ok: true };
        }),
      ),
    createInvite: protectedProcedure
      .input(
        z.object({
          folderPath: z.string().min(1),
          mode: z.enum(['email', 'link']),
          inviteeEmail: z.string().email().optional(),
          permission: z.enum(['read', 'write']).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          const inv = await ctx.invites.create({
            ownerId: ctx.user.id,
            folderPath: input.folderPath,
            mode: input.mode,
            inviteeEmail: input.inviteeEmail,
            permission: input.permission,
          });
          // En email mode no devolvemos el token (ya fue enviado por mail).
          return input.mode === 'link'
            ? inv
            : {
                inviteId: inv.inviteId,
                mode: inv.mode,
                acceptUrl: null as string | null,
                expiresAt: inv.expiresAt,
                token: null as string | null,
              };
        }),
      ),
    listPendingInvites: protectedProcedure.query(({ ctx }) => ctx.invites.listPending(ctx.user.id)),
    revokeInvite: protectedProcedure
      .input(z.object({ inviteId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          await ctx.invites.revoke(ctx.user.id, input.inviteId);
          return { ok: true };
        }),
      ),
    acceptInvite: protectedProcedure
      .input(z.object({ token: z.string().min(1) }))
      .mutation(async ({ ctx, input }) =>
        wrap(() =>
          ctx.invites.accept({
            token: input.token,
            user: { id: ctx.user.id, email: ctx.user.email },
          }),
        ),
      ),
  }),
  apiKeys: t.router({
    list: protectedProcedure.query(({ ctx }) => ctx.apiKeys.list(ctx.user.id)),
    create: protectedProcedure
      .input(z.object({ name: z.string().min(1).max(80), scopes: z.array(z.string()).optional() }))
      .mutation(({ ctx, input }) =>
        ctx.apiKeys.create(ctx.user.id, input.name, input.scopes ?? []),
      ),
    revoke: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        await wrap(() => ctx.apiKeys.revoke(input.id, ctx.user.id));
        return { ok: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
