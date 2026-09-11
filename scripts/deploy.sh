#!/bin/bash
# Deploys BrainStack to Netlify from WSL. Run inside Ubuntu:
#
#   bash scripts/deploy.sh           # draft: builds, uploads, prints the URL
#   bash scripts/deploy.sh publish   # promotes the draft it just verified
#
# Why this is not just `netlify deploy --prod` from Windows — each step below
# exists because its absence produced a broken production deploy once:
#
#  1. Build on Linux. @netlify/plugin-nextjs joins paths with the build
#     machine's separator; built on Windows the handler imports
#     '\var\task\...', which the Lambda runtime reads as an escape sequence.
#  2. Hide pnpm-workspace.yaml. When the CLI sees a monorepo it demands
#     --filter and stamps packagePath=apps/web on the deploy, and with that
#     set the Next catch-all shadows the api function: /api answers 404 from
#     Next instead of reaching the function at all.
#  3. Swap the build command. Without the workspace file `pnpm --filter` has
#     nothing to filter, so core and web build by direct tsc/next calls.
#  4. Copy static assets into the publish dir. Built without packagePath the
#     plugin leaves them in .netlify/static, which the publish dir does not
#     cover — the deploy ships HTML whose every script tag 404s.
#  5. Draft first, promote after. Deploys created with --prod answered 404 on
#     /api while byte-identical drafts answered 200; publishing the verified
#     draft (restoreSiteDeploy) is the path that has never lied.
#
# Requires: Node 20 + unzip on PATH, a clone at ~/brainstack, and a Netlify
# CLI login for the account that owns the site.

set -euo pipefail

SITE_ID="${BRAINSTACK_SITE_ID:-your-netlify-site-id}"
CLONE="${BRAINSTACK_CLONE:-$HOME/brainstack}"
CLI="netlify-cli@27.1.2"

cd "$CLONE"

cleanup() {
  [ -f "$HOME/pnpm-workspace.yaml.deploy-bak" ] &&
    mv "$HOME/pnpm-workspace.yaml.deploy-bak" pnpm-workspace.yaml
  # Restore from the copy taken below, never `git checkout`: the checkout
  # reverts the file to HEAD, which throws away any uncommitted work in it —
  # it silently deleted the [[redirects]] block between two runs and the next
  # deploy answered 404 on every route those rules own.
  [ -f "$HOME/netlify.toml.deploy-bak" ] &&
    mv "$HOME/netlify.toml.deploy-bak" netlify.toml
}
trap cleanup EXIT

# El CLI guarda varias cuentas y usa una sola a la vez. Si la activa no es la
# duena del sitio, `deploy` corta con "Project not found" — pero recien despues
# de que corrieron check:functions y el build entero, tres minutos mas tarde.
# Preguntarlo primero cuesta un request.
echo "== la cuenta activa ve el sitio =="
if ! npx -y "$CLI" api getSite --data "{\"site_id\":\"$SITE_ID\"}" >/dev/null 2>&1; then
  who=$(npx -y "$CLI" api getCurrentUser 2>/dev/null | grep -o '"email": *"[^"]*"' | head -1)
  echo "✗ el CLI no ve el sitio $SITE_ID"
  echo "  cuenta activa: ${who:-desconocida}"
  echo "  corregilo con 'npx netlify switch' y elegi la cuenta duena del sitio"
  exit 1
fi
echo "   si"

echo "== check:functions (la regla: sin verde no se sube) =="
pnpm check:functions

# Sin estas reglas la funcion no recibe /api ni el discovery de OAuth, y el
# sitio se despliega entero con /api en 404. Verificarlo cuesta nada; haberlo
# descubierto despues de subir costo un deploy.
echo "== reglas de ruteo presentes en netlify.toml =="
for rule in '/api/\*' 'oauth-protected-resource' 'oauth-authorization-server'; do
  grep -q "$rule" netlify.toml || { echo "✗ falta el redirect $rule en netlify.toml"; exit 1; }
done
echo "   las tres presentes"

echo "== build sin packagePath =="
# NEXT_PUBLIC_* se incrusta en el bundle del navegador al buildear; vacía,
# el cliente usa el origin de la página, que es lo correcto en todos lados.
export NEXT_PUBLIC_SERVER_URL=""
cp netlify.toml "$HOME/netlify.toml.deploy-bak"
sed -i 's|command = "pnpm --filter @brainstack/core build && pnpm --filter @brainstack/web build"|command = "npx tsc -p packages/core/tsconfig.build.json \&\& cd apps/web \&\& npx next build"|' netlify.toml
mv pnpm-workspace.yaml "$HOME/pnpm-workspace.yaml.deploy-bak"
npx -y "$CLI" build --offline

echo "== assets al publish dir =="
rm -rf apps/web/.next/_next
cp -r .netlify/static/_next apps/web/.next/_next

echo "== deploy draft =="
# Through a file rather than `tee /dev/stderr`: a shell with no terminal
# attached — anything driving this script non-interactively — cannot open
# /dev/stderr for writing, and tee dies before the deploy output is read.
# That failed after the build had already run, which is a slow way to learn it.
DEPLOY_LOG="$(mktemp)"
npx -y "$CLI" deploy --no-build --site "$SITE_ID" 2>&1 | tee "$DEPLOY_LOG"
OUT=$(cat "$DEPLOY_LOG")
rm -f "$DEPLOY_LOG"
DEPLOY_ID=$(printf '%s' "$OUT" | grep -oE 'app.netlify.com/projects/[^/]+/deploys/[a-f0-9]+' | grep -oE '[a-f0-9]{24}' | head -1)
DRAFT_URL=$(printf '%s' "$OUT" | grep -oE 'https://[a-f0-9]+--[a-z0-9-]+\.netlify\.app' | head -1)
[ -n "$DRAFT_URL" ] || { echo "no encontré la Draft URL en la salida"; exit 1; }

echo "== verificación del draft =="
for path in /api/config /login /.well-known/oauth-protected-resource; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 90 "$DRAFT_URL$path")
  echo "   $path -> $status"
  [ "$status" = "200" ] || { echo "✗ $path devolvió $status; no publiques esto"; exit 1; }
done

# El endpoint que hablan los clientes MCP, afirmado en vez de inferido. No pide
# 200: /mcp esta detras de requireAuth y sin token responde 401, que es prueba
# suficiente de que la request llego a la funcion. Un 404 es la firma exacta
# del trap de packagePath — el catch-all de Next contestando en lugar de ella.
echo "== el endpoint MCP llega a la función =="
status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 90 "$DRAFT_URL/api/mcp")
echo "   /api/mcp -> $status"
case "$status" in
  404|5??) echo "✗ /api/mcp devolvió $status; la función no lo está recibiendo, no publiques esto"; exit 1 ;;
  *) echo "   llega (sin token, 401 es lo esperado)" ;;
esac

if [ "${1:-}" = "publish" ]; then
  [ -n "$DEPLOY_ID" ] || { echo "no encontré el deploy id; publicá a mano"; exit 1; }
  echo "== publicando $DEPLOY_ID como producción =="
  npx -y "$CLI" api restoreSiteDeploy \
    --data "{\"site_id\":\"$SITE_ID\",\"deploy_id\":\"$DEPLOY_ID\"}" >/dev/null
  for path in /api/config /login; do
    status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 90 "https://brain.example.com$path")
    echo "   prod $path -> $status"
  done
else
  echo "Draft verificado: $DRAFT_URL"
  echo "Para publicarlo: bash scripts/deploy.sh publish"
fi
