import { createBrowserClient } from '@supabase/ssr'

// No-op Supabase client for build time when env vars are missing
const noopHandler: ProxyHandler<object> = {
  get() {
    return () => Promise.resolve({ data: { user: null, session: null }, error: null })
  }
}
const noopClient = new Proxy({}, noopHandler) as any

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (!url || !key) {
    return noopClient
  }

  return createBrowserClient(url, key)
}
