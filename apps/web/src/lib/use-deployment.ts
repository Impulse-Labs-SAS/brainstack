'use client';

// Hook que descubre el modo de deployment del server vía GET /api/config.
// Cachea para toda la sesión: el deployment no cambia en runtime.

import { useQuery } from '@tanstack/react-query';

import { apiBase } from './server-url';

export interface DeploymentInfo {
  deployment: 'self-host' | 'hosted';
  features: { sharing: boolean };
}


const FALLBACK: DeploymentInfo = {
  deployment: 'self-host',
  features: { sharing: false },
};

export function useDeployment(): DeploymentInfo {
  const { data } = useQuery({
    queryKey: ['deployment-config'],
    queryFn: async (): Promise<DeploymentInfo> => {
      const res = await fetch(`${apiBase()}/config`, {
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
