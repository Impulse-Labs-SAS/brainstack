'use client';

// Hook que descubre el modo de deployment del server vía GET /api/config.
// Cachea para toda la sesión: el deployment no cambia en runtime.

import { useQuery } from '@tanstack/react-query';

export interface DeploymentInfo {
  deployment: 'self-host' | 'hosted';
  features: { sharing: boolean };
}

function serverUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3000';
  }
  return (
    process.env.NEXT_PUBLIC_SERVER_URL ?? window.location.origin.replace(':3001', ':3000')
  );
}

const FALLBACK: DeploymentInfo = {
  deployment: 'self-host',
  features: { sharing: false },
};

export function useDeployment(): DeploymentInfo {
  const { data } = useQuery({
    queryKey: ['deployment-config'],
    queryFn: async (): Promise<DeploymentInfo> => {
      const res = await fetch(`${serverUrl()}/api/config`, {
        credentials: 'include',
      });
      if (!res.ok) return FALLBACK;
      return (await res.json()) as DeploymentInfo;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  return data ?? FALLBACK;
}

export function useSharingEnabled(): boolean {
  return useDeployment().features.sharing;
}
