'use client';

// Página de error del flujo de aceptar invitaciones. El endpoint REST
// /invite/accept/:token redirige acá con ?reason=<AppError.code> cuando
// el accept falla (token inválido, expirado, revocado, etc.).

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const REASON_COPY: Record<string, { title: string; body: string }> = {
  not_found: {
    title: 'Invitación no encontrada',
    body: 'El link puede haber sido revocado o el token está mal formado.',
  },
  forbidden: {
    title: 'Sin acceso',
    body: 'Esta invitación no está dirigida a tu cuenta. Si tenés varias, probá iniciar sesión con la dirección correcta.',
  },
  invalid_input: {
    title: 'Invitación inválida',
    body: 'El token tiene un formato inválido. Pedile al dueño que te genere uno nuevo.',
  },
  already_exists: {
    title: 'Ya aceptaste esta invitación',
    body: 'Buscá la carpeta bajo "Compartido conmigo" en el sidebar.',
  },
  internal: {
    title: 'Error inesperado',
    body: 'Algo falló del lado del server. Probá de nuevo en un rato o pedile al dueño que te genere otra invitación.',
  },
};

function InviteErrorView() {
  const params = useSearchParams();
  const reason = (params.get('reason') ?? 'internal').toLowerCase();
  const copy = REASON_COPY[reason] ?? REASON_COPY.internal!;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-6 py-16">
      <div className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
        invitación · error
      </div>
      <h1 className="text-lg font-medium text-fg-primary">{copy.title}</h1>
      <p className="text-sm text-fg-secondary">{copy.body}</p>
      <div className="mt-2 font-mono text-[11px] text-fg-muted">reason: {reason}</div>
      <div className="mt-6 flex gap-3">
        <Link
          href="/notes"
          className="rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated"
        >
          Ir a mis notas
        </Link>
      </div>
    </div>
  );
}

export default function InviteErrorPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-6 py-16 font-mono text-[11px] text-fg-muted">
          cargando…
        </div>
      }
    >
      <InviteErrorView />
    </Suspense>
  );
}
