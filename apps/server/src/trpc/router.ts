// Root tRPC router. The web app talks to the server exclusively through this
// router; MCP clients go through the dedicated MCP transports. Both share the
// same underlying services, so behaviour stays consistent.

import { TRPCError, initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';

import { AppError } from '../lib/errors.js';
import { MAX_TREE_DEPTH } from '../services/NoteService.js';

import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      appCode:
        error.cause instanceof AppError ? error.cause.code : (shape.data.code as string),
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

export const appRouter = t.router({
  auth: t.router({
    me: t.procedure.query(({ ctx }) => ({ user: ctx.user })),
    logout: protectedProcedure.mutation(() => ({ ok: true })),
  }),
  notes: t.router({
    get: protectedProcedure
      .input(z.object({ path: z.string().min(1) }))
      .query(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanRead(ctx.user.id, ctx.user.id, input.path);
          return ctx.notes.get(input.path);
        }),
      ),
    list: protectedProcedure
      .input(
        z
          .object({
            folder: z.string().optional(),
            tag: z.string().optional(),
            status: z.string().optional(),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) => ctx.notes.list(input ?? {})),
    create: protectedProcedure
      .input(
        z.object({ path: z.string().min(1), content: z.string(), frontmatter: FrontmatterInput }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanWrite(ctx.user.id, ctx.user.id, input.path);
          return ctx.notes.create(input.path, input.content, input.frontmatter);
        }),
      ),
    update: protectedProcedure
      .input(z.object({ path: z.string().min(1), content: z.string() }))
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanWrite(ctx.user.id, ctx.user.id, input.path);
          return ctx.notes.update(input.path, input.content);
        }),
      ),
    remove: protectedProcedure
      .input(
        z.object({
          path: z.string().min(1),
          recursive: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanWrite(ctx.user.id, ctx.user.id, input.path);
          return ctx.notes.remove(input.path, { recursive: input.recursive });
        }),
      ),
    move: protectedProcedure
      .input(z.object({ from: z.string().min(1), to: z.string().min(1) }))
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanWrite(ctx.user.id, ctx.user.id, input.from);
          ctx.sharing.assertCanWrite(ctx.user.id, ctx.user.id, input.to);
          return ctx.notes.move(input.from, input.to);
        }),
      ),
    createFolder: protectedProcedure
      .input(z.object({ path: z.string().min(1) }))
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanWrite(ctx.user.id, ctx.user.id, input.path);
          return ctx.notes.createFolder(input.path);
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
        wrap(() => ctx.notes.listTree(input?.path, input?.depth)),
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
      .query(({ ctx, input }) => ctx.notes.listDecisions(input ?? {})),
    uploadAttachment: protectedProcedure
      .input(
        z.object({
          path: z.string().min(1),
          dataBase64: z.string().min(1),
          mime: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanWrite(ctx.user.id, ctx.user.id, input.path);
          return ctx.notes.uploadAttachment({
            path: input.path,
            dataBase64: input.dataBase64,
            mime: input.mime,
          });
        }),
      ),
    getAttachment: protectedProcedure
      .input(z.object({ path: z.string().min(1) }))
      .query(async ({ ctx, input }) =>
        wrap(() => {
          ctx.sharing.assertCanRead(ctx.user.id, ctx.user.id, input.path);
          return ctx.notes.getAttachment(input.path);
        }),
      ),
    backlinks: protectedProcedure
      .input(z.object({ path: z.string().min(1) }))
      .query(({ ctx, input }) => {
        ctx.sharing.assertCanRead(ctx.user.id, ctx.user.id, input.path);
        return ctx.notes.listLinks(input.path);
      }),
    graph: protectedProcedure.query(({ ctx }) => ctx.notes.graph()),
  }),
  search: t.router({
    query: protectedProcedure
      .input(z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }))
      .query(({ ctx, input }) => ctx.search.search(input.query, { limit: input.limit })),
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
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          if (!ctx.sharing.enabled) {
            throw new AppError('sharing no disponible en este deployment', 'NOT_FOUND', 404);
          }
          const target = ctx.auth.getUserByEmail(input.email);
          if (!target) {
            // El flow con invitación por email/link entra en el paso 9.
            throw new AppError('user no encontrado; usar invitación', 'NOT_FOUND', 404);
          }
          const id = ctx.sharing.grant({
            ownerId: ctx.user.id,
            sharedWithUserId: target.id,
            folderPath: input.folderPath,
            grantedBy: ctx.user.id,
          });
          return { id, sharedWithUserId: target.id };
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
        wrap(() => {
          if (!ctx.sharing.enabled) {
            throw new AppError('sharing no disponible en este deployment', 'NOT_FOUND', 404);
          }
          ctx.sharing.revoke({
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
        }),
      )
      .mutation(async ({ ctx, input }) =>
        wrap(async () => {
          const inv = await ctx.invites.create({
            ownerId: ctx.user.id,
            folderPath: input.folderPath,
            mode: input.mode,
            inviteeEmail: input.inviteeEmail,
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
    listPendingInvites: protectedProcedure.query(({ ctx }) =>
      ctx.invites.listPending(ctx.user.id),
    ),
    revokeInvite: protectedProcedure
      .input(z.object({ inviteId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) =>
        wrap(() => {
          ctx.invites.revoke(ctx.user.id, input.inviteId);
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
        await wrap(() => Promise.resolve(ctx.apiKeys.revoke(input.id)));
        return { ok: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
