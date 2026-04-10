// src/supabase/client.js
// Single Supabase client instance — import this everywhere instead of firebase/config

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
const serviceRoleKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env')
}

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,         // keep admin session across page reloads
    autoRefreshToken: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
})

// Admin client for user management (Super Admin only)
// Uses service_role key to call GoTrue Admin API properly
export const supabaseAdmin = serviceRoleKey && serviceRoleKey !== 'PASTE_YOUR_SERVICE_ROLE_KEY_HERE'
  ? createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null

export default supabase

