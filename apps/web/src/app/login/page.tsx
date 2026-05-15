'use client';

// Placeholder login page. The new email+password / Google OAuth flow lands
// in the next commits — this stub exists only to keep redirects valid while
// the magic-link UI is removed.

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-bg-surface p-6 shadow-lg">
        <div className="mb-1 font-mono text-xs text-fg-muted">brainstack</div>
        <h1 className="mb-4 text-xl font-medium text-fg-primary">Sign in</h1>
        <p className="text-sm text-fg-secondary">
          Auth is being rebuilt. Email + password and Google OAuth will be available shortly.
        </p>
      </div>
    </div>
  );
}
