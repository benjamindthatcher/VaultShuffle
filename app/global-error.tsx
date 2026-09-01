'use client';

import { useEffect } from 'react';
import { captureProductEvent } from '@/lib/posthog-client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureProductEvent('client_render_failed', {
      // Next's numeric digest connects this boundary to the server log. Never
      // send the raw message/stack: either may contain user-provided data.
      digest: error.digest && /^[0-9]{1,20}$/.test(error.digest) ? error.digest : undefined,
      source: 'global_error_boundary',
    });
  }, [error]);
  return (
    <html lang="en">
      <body>
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <h2>Something went wrong</h2>
          <button onClick={() => reset()}>Try again</button>
        </div>
      </body>
    </html>
  );
}
