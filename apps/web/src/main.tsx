import '@fontsource-variable/inter';
import './index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
import { initAppearance } from './design/glass/appearance';
import { GlassRuntime } from './design/glass/GlassRuntime';
import { router } from './router';

// Préférences d'apparence appliquées avant le premier rendu (pas de flash de style).
initAppearance();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <GlassRuntime />
      <RouterProvider router={router} />
      <Toaster
        theme="dark"
        position="bottom-right"
        richColors
        closeButton
        mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 6.25rem)' }}
        toastOptions={{ className: 'lg-toast' }}
      />
    </QueryClientProvider>
  </StrictMode>,
);
