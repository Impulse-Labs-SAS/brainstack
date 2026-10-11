'use client';

// The last stop before Next's bare "Application error" screen.

import { Button } from '@/components/ui/button';

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg-base p-6 text-sm"
    >
      <p className="text-fg-primary">Something went wrong on this page.</p>
      <Button size="sm" onPress={reset}>
        Try again
      </Button>
    </div>
  );
}
