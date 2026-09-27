# Sharing de carpetas — diseño

> **Estado**: V1 implementado. V2 (escritura) implementado — ver §17. Migración entre bóvedas — ver §18.
> **Scope**: hosted deployment de Impulse Labs únicamente. Self-host queda single-user.
> **Licencia**: todo el código vive en este repo bajo AGPL-3.0.

> **Nota de lectura.** Las secciones 1–11 describen V1, que era **read-only por
> decisión de este documento**. Esa decisión resultó equivocada: la intención del
> proyecto siempre fue compartir con lectura y escritura, y el código la siguió
> al pie de la letra. La §17 documenta la corrección. Donde las dos se
> contradigan, manda la §17.

## 1. Contexto y problema

BrainStack hoy es single-user: hay un único vault físico apuntado por `NOTES_DIR`, todas las notas pertenecen implícitamente al único usuario logueado, y los servicios (`NoteService`, `SearchService`, `IndexService`) no tienen el concepto de "dueño". El frontend muestra un árbol único, el MCP server expone tools que escriben/leen sin chequear identidad.

El deployment hosted necesita que un usuario pueda **compartir carpetas con otros usuarios** para construir un cerebro común (equipos, parejas, comunidades). En V1:

- ~~**Read-only**: el invitado puede leer, no editar.~~ **Superado por §17**: el
  permiso es por grant, `read` o `write`.
- **Granularidad por carpeta**, no nota suelta.
- **Sharing solo en hosted**: self-host mantiene su comportamiento single-user actual sin cambios visibles.

## 2. Lo que NO entra en V1

- ~~Edición concurrente sobre lo compartido (read-only).~~ **Superado por §17**,
  con la salvedad de que sigue sin haber merge: dos personas editando la misma
  nota es last-write-wins.
- Sharing público sin login.
- Sharing de notas sueltas.
- ~~Permisos granulares por rol (admin/editor/viewer). Solo "viewer".~~
  **Parcialmente superado por §17**: hay `read` y `write`, no roles.
- Sharing transitivo (B no puede re-compartir lo que A le compartió).
- Sync en tiempo real (los cambios del dueño llegan al invitado vía polling/refetch normal).

## 3. Modos de deployment

Nuevo env var `BRAINSTACK_DEPLOYMENT`:

- `self-host` (default si unset) — comportamiento actual.
- `hosted` — activa multi-tenant + sharing.

El valor se lee en `apps/server/src/config/env.ts` y se expone al frontend vía un nuevo endpoint público `GET /api/config`:

```json
{ "deployment": "hosted", "features": { "sharing": true } }
```

Self-host devuelve `{ "deployment": "self-host", "features": { "sharing": false } }`.

El frontend lee este endpoint al boot vía hook `useDeployment()` y cachea. Toda UI de sharing queda escondida si `features.sharing === false`.

**Doble candado**: además del gating UI, las rutas tRPC `sharing.*`, los endpoints REST de invites, las MCP tools nuevas (`list_shared_with_me`) y el plumbing de authz cross-owner se registran **solo si** el server arranca en modo hosted. Un cliente que llame `sharing.shareFolder` contra un server self-host recibe `NOT_FOUND` del router.

## 4. Modelo de datos

Schema en `packages/core/src/db/schema.ts`. Una migration Drizzle nueva por paso commiteable.

### 4.1 Cambios a tablas existentes

```ts
notes: {
  // existing: path PK, title, frontmatter, body, mtime, checksum
  owner_id: TEXT REFERENCES users(id),  // nullable, indexed
}

attachments: {
  // existing
  owner_id: TEXT REFERENCES users(id),  // nullable, indexed
}
```

`links` y `tags` heredan el owner del `source_path`/`note_path` correspondiente (no se duplica la columna, se hace JOIN).

**Backfill**: al boot, si se detectan filas con `owner_id IS NULL`:

- Self-host con exactamente un user en la tabla `users` → setea todas a ese `user.id`.
- Self-host con cero users → backfill diferido hasta el primer signup; se hace en ese momento.
- Hosted → no debería ocurrir (notas siempre se crean con owner conocido); si ocurre, se loggea warning y se omite la nota del listado hasta que un admin la reasigne.

Backfill es idempotente: corre cada boot, no hace nada si no hay nulls.

### 4.2 Tablas nuevas (existen en ambos modos, solo se usan en hosted)

```ts
folder_shares: {
  id: TEXT PK,                          // ulid
  folder_path: TEXT NOT NULL,           // relativo al vault del dueño, sin slash inicial
  owner_id: TEXT NOT NULL REFERENCES users(id),
  shared_with_user_id: TEXT NOT NULL REFERENCES users(id),
  granted_at: INTEGER NOT NULL,
  granted_by: TEXT NOT NULL REFERENCES users(id),  // normalmente = owner_id, pero queda explícito por auditoría
  UNIQUE (folder_path, owner_id, shared_with_user_id)
}
// índices: (shared_with_user_id, folder_path), (owner_id, folder_path)

folder_share_invites: {
  id: TEXT PK,
  folder_path: TEXT NOT NULL,
  owner_id: TEXT NOT NULL REFERENCES users(id),
  mode: TEXT NOT NULL,                  // 'email' | 'link'
  invitee_email: TEXT,                  // NULL si mode='link'
  token_hash: TEXT NOT NULL UNIQUE,     // SHA-256 del token plano
  expires_at: INTEGER NOT NULL,         // epoch ms, +7 días por default
  accepted_at: INTEGER,                 // NULL hasta accept
  accepted_by_user_id: TEXT REFERENCES users(id),
  revoked_at: INTEGER,
  created_at: INTEGER NOT NULL
}
// índice: (owner_id, folder_path), (invitee_email)
```

## 5. Layout de filesystem

### Self-host

`NOTES_DIR` plano como hoy. Sin cambios. Sin migración disruptiva.

### Hosted

Cada user vive bajo `NOTES_DIR/<userId>/`. El vault root del user A es `NOTES_DIR/<A.id>/`. El vault root de B es `NOTES_DIR/<B.id>/`. Aislamiento físico = blast radius mínimo si la authz lógica fallara.

**Cuando A comparte la carpeta `proyectos/` con B**:

- En la DB queda una fila `folder_shares(folder_path='proyectos', owner_id=A, shared_with_user_id=B)`.
- El archivo físico sigue siendo `NOTES_DIR/<A.id>/proyectos/...`. No hay copia ni symlink.
- B lee a través de los servicios, que resuelven el path del dueño correspondiente y verifican `canRead` antes de devolver bytes.

### Resolver

Nuevo helper en `apps/server/src/lib/vault.ts`:

```ts
function resolveVaultRoot(userId: string, cfg: AppConfig): string {
  if (cfg.deployment === 'self-host') return cfg.notesDirAbs;
  return path.join(cfg.notesDirAbs, userId); // auto-mkdir on first use
}
```

Todas las operaciones que tocan el FS llaman a `resolveVaultRoot(targetOwnerId, cfg)` para construir el path absoluto, y luego pasan ese root a `safeResolve()` (que ya existe en `packages/core/src/fs/paths.ts`).

## 6. Authz central — `SharingService`

Nuevo archivo `apps/server/src/services/SharingService.ts`. Único punto de verdad para "¿este user puede leer/escribir este path?".

```ts
class SharingService {
  canRead(userId: string, ownerId: string, relPath: string): boolean;
  canWrite(userId: string, ownerId: string, relPath: string): boolean;
  assertCanRead(userId, ownerId, relPath): void; // throws TRPCError FORBIDDEN
  assertCanWrite(userId, ownerId, relPath): void;
  listSharedRoots(userId): Array<{ folderPath; ownerId; ownerDisplayName }>;
  resolveTargetOwner(userId, requestedPath): { ownerId; relPath };
  // dado un path lógico del request, decide qué vault root usar
}
```

**Reglas**:

- `canRead`: si `userId === ownerId` → true. Si no, buscar `folder_shares` donde `shared_with_user_id = userId` y `relPath` empieza con (o iguala) algún `folder_path`.
- `canWrite`: solo `userId === ownerId` en V1.
- En self-host: short-circuit, todo es `true` (no consulta tabla).

**Cache por request**: el contexto tRPC y MCP cachea `listSharedRoots(userId)` por request para evitar N+1 en listados grandes.

## 7. Cambios en services existentes

### NoteService

- Métodos read (`get`, `list`, `listTree`, `listDecisions`, `backlinks`, `graph`) reciben `principal: User` y consultan `SharingService.resolveTargetOwner()` para saber qué vault root usar y filtrar resultados a `(owner_id = me) OR (owner_id, path) IN listSharedRoots`.
- Métodos write (`create`, `update`, `remove`, `move`, `createFolder`, `uploadAttachment`, `getAttachment`) verifican `assertCanWrite(principal.id, ownerId, relPath)` antes de tocar FS o DB. En V1 esto significa: solo el dueño puede escribir, y siempre escribe en su propio vault root.

### SearchService

- `search(query, principal)` agrega filtro SQL `owner_id IN (me, ...sharedOwnerIds)` y excluye matches cuyo `path` no caiga bajo un scope visible.

### IndexService

- Al indexar una nota nueva (vía watcher), determina `owner_id` por la posición física en el FS: si el path está bajo `NOTES_DIR/<userId>/...`, owner es ese userId; si está plano (self-host), usa el helper de backfill.

## 8. tRPC

### Router nuevo `sharing` (solo si `cfg.deployment === 'hosted'`)

Archivo: `apps/server/src/trpc/routers/sharing.ts`.

```ts
sharing.shareFolder({ path, mode: 'email'|'link', inviteeEmail? })
  → { inviteId, tokenForLink? }   // tokenForLink solo si mode='link'
sharing.revoke({ folderPath, sharedWithUserId })
sharing.revokeInvite({ inviteId })
sharing.listMyShares()             // { folderPath, members: [{userId, email, grantedAt}], pendingInvites: [...] }[]
sharing.listSharedWithMe()         // { folderPath, ownerId, ownerDisplayName }[]
sharing.acceptInvite({ token })    // link mode flow
```

### Cambios en procedures existentes

`notes.*` y `search.*` pasan `ctx.user` y `ctx.sharing` a los services. Todos los procedures lanzan `FORBIDDEN` si falla `assertCanRead/Write`.

`notes.tree` acepta nuevo arg opcional `scope?: 'mine' | 'shared' | 'all'` (default `mine`) y `rootOwnerId?: string` para navegar dentro de una carpeta compartida concreta.

## 9. MCP

`buildMcpServer` cambia firma a `buildMcpServer(services, principal: Principal)`. El principal se inyecta por request HTTP en el transport HTTP MCP, o por el user configurado en el server stdio.

**Tools en hosted**:

- Todas las existentes verifican authz.
- Nueva: `list_shared_with_me` → equivalente a `sharing.listSharedWithMe`.
- `list_tree` y `search_brain` aceptan `scope?: 'mine' | 'shared' | 'all'`.
- Mutaciones (`update_note`, `delete`, `move`, `create_note`, `create_folder`, `upload_attachment`) tiran error si el path target cae fuera del scope propio del invitado (no puede escribir en lo compartido).

**Tools en self-host**: comportamiento idéntico a hoy, sin authz, sin `list_shared_with_me`.

## 10. Wikilinks cross-border

Cuando se implemente el resolver client-side de wikilinks (hoy CodeMirror muestra sintaxis cruda — ver `apps/web/src/components/editor/note-editor.tsx:40`), debe respetar la política:

- **Target dentro del scope visible** → link normal, click navega.
- **Target fuera del scope visible** (existe en otro user o en una carpeta no compartida) → render como **link roto enmascarado**, idéntico al de "nota inexistente". No revela existencia ni path. Tooltip neutro tipo "Nota no encontrada".

El backend cubre esta política en:

- `notes.backlinks`: filtra backlinks cuyo `source_path` no es visible.
- `notes.graph`: poda nodos no visibles.
- Cualquier `links` join: filtrado por authz.

## 11. Flujo de invitación

### Email mode

1. A → `sharing.shareFolder({ path: 'proyectos', mode: 'email', inviteeEmail: 'b@x.com' })`.
2. Backend genera token aleatorio (32 bytes URL-safe), guarda `sha256(token)` en `folder_share_invites`, manda email vía Resend con link `https://<host>/invite/accept/<token>`.
3. B abre el link:
   - **No logueado** → `/login?next=/invite/accept/<token>`. Login redirige al accept.
   - **Logueado y email matchea `invitee_email`** → endpoint REST `/invite/accept/:token` valida, crea row en `folder_shares`, marca `accepted_at`, redirige a `/notes/<folderPath>`.
   - **Logueado pero email no matchea** → error "esta invitación es para otro email".
   - **No existe user con ese email** → `/signup?invite=<token>`. Al completar signup, accept automático.

### Link mode

1. A → `sharing.shareFolder({ path: 'proyectos', mode: 'link' })` → devuelve `tokenForLink` (mostrado UNA vez en UI).
2. A copia el link `https://<host>/invite/accept/<tokenForLink>` y lo manda por el canal que quiera.
3. Cualquier user logueado que abra el link acepta y queda con acceso. Token es **multi-use** hasta que A lo revoque.

### Revocación

- `sharing.revoke({ folderPath, sharedWithUserId })` elimina la row de `folder_shares`.
- `sharing.revokeInvite({ inviteId })` marca `revoked_at` y el token deja de funcionar.

## 12. UX frontend

Todo lo siguiente está gated por `useDeployment().features.sharing === true`.

### File-tree (`apps/web/src/components/file-tree/file-tree.tsx`)

Dos secciones top-level colapsables:

1. **Mi cerebro** — árbol propio actual, sin cambios.
2. **Compartido conmigo** — un nodo por carpeta compartida, con badge "@dueño". Click expande igual que cualquier carpeta. Datos vía `sharing.listSharedWithMe` + `notes.tree({ rootOwnerId, rootPath })`.

Context menu en carpeta propia → nueva acción "**Compartir…**" que abre el modal.

### Modal de compartir (`apps/web/src/components/sharing/share-folder-modal.tsx`, nuevo)

Basado en `prompt-modal.tsx`:

- Header: nombre de carpeta.
- Lista actual de miembros con botón "revocar" por fila.
- Lista de invitaciones pendientes con botón "revocar" + "copiar link" (si es link mode).
- Input email + botón "invitar por email".
- Botón "generar link compartible".

### Command palette (`apps/web/src/components/search/command-palette.tsx`)

Toggle pill `Mine | Shared | All` arriba del input. Pasa `scope` al backend.

### Graph view (`apps/web/src/components/graph/graph-view.tsx`)

Checkbox "Incluir compartidos". Default off.

> Superseded: shared vaults are now a layer of the graph, shown by default and hidden or
> isolated per vault. "Include shared vaults" lives in the Layers menu
> (`graph-layers.tsx`), on by default; off, shared vaults are not fetched at all. See
> `Graph-design.md`.

### Aceptación de invitación

- Página nueva `apps/web/src/app/invite/accept/[token]/page.tsx` que llama al endpoint REST y maneja los 3 estados (logueado/no-logueado/email-mismatch).

## 13. Endpoint de config

`apps/server/src/http/routes/config.ts` (nuevo): `GET /api/config` público (sin auth), responde:

```ts
{
  deployment: 'self-host' | 'hosted',
  features: { sharing: boolean }
}
```

Frontend: `apps/web/src/lib/use-deployment.ts` hook que hace fetch al boot, cachea en React Query con `staleTime: Infinity`.

## 14. Cambios mínimos al código existente — checklist

| Archivo                                                  | Cambio                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/server/src/config/env.ts:12`                       | Agregar `BRAINSTACK_DEPLOYMENT` al schema zod, default `self-host`                            |
| `apps/server/src/http/routes/config.ts`                  | **Nuevo**                                                                                     |
| `apps/server/src/http/server.ts` (donde registra routes) | Wire `/api/config`                                                                            |
| `apps/server/src/lib/vault.ts`                           | **Nuevo** — `resolveVaultRoot`                                                                |
| `apps/server/src/services/SharingService.ts`             | **Nuevo**                                                                                     |
| `apps/server/src/services/InviteService.ts`              | **Nuevo**                                                                                     |
| `apps/server/src/services/NoteService.ts`                | Refactor todos los métodos para usar `vault.resolveVaultRoot` y `sharing.assertCanRead/Write` |
| `apps/server/src/services/SearchService.ts:21`           | Agregar filtro owner en `search()`                                                            |
| `apps/server/src/services/IndexService.ts`               | Asignar `owner_id` al indexar; backfill                                                       |
| `apps/server/src/trpc/context.ts:24`                     | Inyectar `sharing` service en ctx                                                             |
| `apps/server/src/trpc/router.ts:61`                      | Authz en cada `notes.*` y `search.*`; registrar `sharing.*` si hosted                         |
| `apps/server/src/trpc/routers/sharing.ts`                | **Nuevo**                                                                                     |
| `apps/server/src/mcp/server.ts:41`                       | Recibir principal, authz por tool, registrar `list_shared_with_me` si hosted                  |
| `apps/server/src/http/routes/invite.ts`                  | **Nuevo**                                                                                     |
| `packages/core/src/db/schema.ts`                         | `owner_id` en notes/attachments, tablas `folder_shares`, `folder_share_invites`               |
| `packages/core/drizzle/<n>_owner_id.sql`                 | **Nuevo**                                                                                     |
| `packages/core/drizzle/<n>_sharing.sql`                  | **Nuevo**                                                                                     |
| `apps/web/src/lib/use-deployment.ts`                     | **Nuevo**                                                                                     |
| `apps/web/src/components/file-tree/file-tree.tsx:277`    | Sección "Compartido conmigo" + acción "Compartir…" en context menu                            |
| `apps/web/src/components/sharing/share-folder-modal.tsx` | **Nuevo**                                                                                     |
| `apps/web/src/components/search/command-palette.tsx`     | Toggle de scope                                                                               |
| `apps/web/src/components/graph/graph-view.tsx`           | Checkbox incluir compartidos                                                                  |
| `apps/web/src/app/invite/accept/[token]/page.tsx`        | **Nuevo**                                                                                     |

## 15. Riesgos y open questions

- **Resend env vars**: confirmar `RESEND_API_KEY` y `EMAIL_FROM` ya están en `env.ts` antes del paso 9.
- **Performance de authz**: `canRead` se llama por nota en listados grandes. Mitigación: cache de `listSharedRoots(userId)` por request.
- **Migración hosted greenfield**: este diseño asume que no hay vaults hosted ya en uso con layout plano. Si surge, requiere script de migración separado.
- **Wikilink resolver server-side**: hoy no existe; este doc documenta la política para que la futura implementación no la olvide.
- **Watcher cross-user**: el filesystem watcher en hosted debe seguir funcionando con la estructura `NOTES_DIR/<userId>/...`. Verificar que el chokidar root sea `NOTES_DIR` y la detección de `userId` salga del path al evento.

## 16. Verificación end-to-end

1. **Self-host (default)**: `BRAINSTACK_DEPLOYMENT` unset → `pnpm test` verde. UI sin sección "Compartido conmigo". tRPC: `sharing.*` no listado. MCP: `list_shared_with_me` no existe.
2. **Hosted**: dos users A, B. A crea `proyectos/`, comparte con B vía email. B acepta, ve `proyectos/` bajo "Compartido conmigo", lee notas, NO puede editar. B intenta `update_note` vía MCP → FORBIDDEN. Wikilink desde nota compartida a nota privada de A → renderea roto.
3. **Tests automatizados**: suite `sharing-dualmode.test.ts` levanta server en ambos modos y assertea gating + aislamiento.

---

## 17. V2 — escritura sobre lo compartido

### Por qué

V1 quedó read-only porque este documento lo puso fuera de scope, y el código fue
fiel al documento. Pero la intención del proyecto era compartir con lectura y
escritura, así que el bug estaba acá, en el diseño, y todo lo demás lo heredó.

El síntoma con el que se descubrió: alguien con acceso de lectura le pidió a su
asistente que escribiera en la carpeta compartida. Ninguna tool recibía un dueño,
así que el path se resolvió contra el vault del que llamaba. La escritura
funcionó, reportó éxito, y creó una carpeta homónima privada. Nadie más volvió a
ver esa nota.

### El modelo

**Direccionar es lo primero.** Antes de discutir permisos hacía falta poder
_nombrar_ una carpeta ajena. Toda tool de notas y toda ruta tRPC acepta un
`ownerId` opcional; omitido es el que llama, dado es el dueño del vault contra
el que se resuelve el path. Los paths dentro de una carpeta compartida son
relativos a la raíz **del dueño**, igual que los reporta `list_shared_with_me`.

**El permiso vive en el grant.** `folder_shares.permission` es `'read'` o
`'write'`, con default `'read'` — los grants anteriores a la columna significan
exactamente lo que significaban. `canWrite` lo consulta, lo que la vuelve async.
`folder_share_invites` lleva la misma columna: el dueño elige el permiso al
invitar y la aceptación puede ser días después.

**La propiedad la define la carpeta, no quien escribe.** Una nota que un invitado
crea en una carpeta compartida se guarda con el `owner_id` del dueño de la
carpeta y vive en su vault. Si quedara a nombre de quien la escribió,
desaparecería de la carpeta para todos los demás — el share dejaría de cubrirla.

**Entre grants anidados gana el más ancho.** Si una carpeta está compartida con
`read` y una subcarpeta con `write`, el `write` no queda cancelado por el padre,
y tampoco se derrama sobre el resto de él.

**Re-compartir cambia el permiso.** No es un no-op: subir a `write` o bajar a
`read` es el mismo gesto que compartir por primera vez, y actualiza la fila
existente en lugar de duplicarla.

### Lo que sigue prohibido

- **Escribir sin `ownerId` a un path que nombra una carpeta compartida.** Tener
  permiso de escritura no desambigua: `impulse-labs/nota.md` puede ser
  perfectamente una carpeta propia. El servidor rechaza la llamada y dice qué
  `ownerId` pasar. Es la única forma honesta de responder una pregunta ambigua.
- **Mover entre vaults con `move`.** Resuelve sus dos extremos contra un solo
  dueño, así que ahí sigue siendo imposible — y está bien que lo sea: es lo que
  vuelve segura una mudanza común. El cruce es otra operación, con un costo que
  `move` no tiene, y vive aparte en `moveAcrossVaults` (§18).
- **Sharing transitivo.** Sigue sin poder re-compartirse lo recibido.

### Lo que queda pendiente

- **Merge.** Dos personas editando la misma nota es last-write-wins. No hay
  detección de conflicto ni edición concurrente real.
- **Attachments cross-owner.** `upload_attachment` y `getAttachment` no toman
  `ownerId` todavía.
- **Limpieza de las copias creadas por el bug.** Ver `scripts/find-shadow-copies.mjs`.

---

## 18. Migrar entre bóvedas

Compartir con escritura destapó el pedido siguiente: alguien ya cargó material
en su bóveda personal justamente porque no podía escribir en la compartida, y
eso hay que poder mudarlo.

`moveAcrossVaults` es la segunda operación que abarca dos bóvedas (la otra es
`graph`). Mueve una nota o una carpeta entera de la bóveda de A a la de B, y
las notas quedan a nombre de B — si quedaran a nombre de quien las escribió,
desaparecerían de la carpeta compartida para todos los demás.

**Permiso en los dos extremos.** Sacar algo de una bóveda es una escritura sobre
esa bóveda, no una lectura. Así que hace falta `write` en el origen y `write`
en el destino, y son dos grants distintos.

**El costo son los links, y se informa.** Un wikilink dice `[[Brutus/nota]]`; no
tiene forma de decir de quién es ese Brutus. Entonces un link que antes cruzaba
lo que ahora es un borde entre bóvedas no se puede reescribir a algo correcto
— solo se puede reportar. El resultado trae las dos direcciones:

- `linksLeftDangling`: lo que se mudó, apuntando a lo que quedó.
- `linksNowBroken`: lo que quedó, apuntando a lo que se mudó.

Los links que ya estaban rotos antes del cruce no se cuentan: el reporte le
atribuye a la mudanza su propio daño y nada más.

**Nada a medias.** Las colisiones en el destino se detectan antes de mover el
primer archivo. El store no tiene transacción que revertir, así que fallar en la
novena nota dejaría ocho mudadas y la carpeta partida en dos lugares.

### En la interfaz

Arrastrar y soltar sobre una carpeta de "shared with me" hace la migración. Las
carpetas de solo lectura no se ofrecen como destino: no habilitar el drop es la
forma amable de decir lo que el servidor diría con un 403.
