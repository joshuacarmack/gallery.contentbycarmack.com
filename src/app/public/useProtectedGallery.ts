import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';

type State<T> =
  | { kind: 'loading' }
  | { kind: 'notfound' }
  | { kind: 'locked'; title: string }
  | { kind: 'ready'; data: T };

/**
 * Loads a password-protected resource. Handles the baked-in `?k=` link (§5):
 * auto-submits the password, then strips it from the URL via replaceState.
 */
export function useProtectedGallery<T>(slug: string, fetcher: () => Promise<T>) {
  const [state, setState] = useState<State<T>>({ kind: 'loading' });
  const triedKey = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await fetcher();
      setState({ kind: 'ready', data });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        const body = e.body as { title?: string } | null;

        const params = new URLSearchParams(window.location.search);
        const key = params.get('k');
        if (key !== null && !triedKey.current) {
          triedKey.current = true;
          params.delete('k');
          const qs = params.toString();
          window.history.replaceState(
            null,
            '',
            window.location.pathname + (qs ? `?${qs}` : ''),
          );
          try {
            await api.auth(slug, key);
            return load();
          } catch {
            // fall through to the password form
          }
        }
        setState({ kind: 'locked', title: body?.title ?? '' });
      } else if (e instanceof ApiError && e.status === 404) {
        setState({ kind: 'notfound' });
      } else {
        throw e;
      }
    }
  }, [slug, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitPassword = useCallback(
    async (password: string): Promise<boolean> => {
      try {
        await api.auth(slug, password);
      } catch {
        return false;
      }
      await load();
      return true;
    },
    [slug, load],
  );

  return { state, reload: load, submitPassword };
}
