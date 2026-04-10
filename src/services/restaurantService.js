// src/services/restaurantService.js
// Restaurant CRUD + user management RPCs

import { supabase, supabaseAdmin } from '../supabase/client'
import { deleteMenuImage } from './menuService'

const TABLE = 'restaurants'

// ── Fetch all restaurants ─────────────────────────────────────────────────────
export async function fetchRestaurants() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// ── Fetch restaurant by slug ──────────────────────────────────────────────────
export async function fetchRestaurantBySlug(slug) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('slug', slug)
    .single()
  if (error) throw error
  return data
}

// ── Fetch restaurant by ID ────────────────────────────────────────────────────
export async function getRestaurantById(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

// ── Check if slug is taken ────────────────────────────────────────────────────
export async function isSlugAvailable(slug) {
  if (!slug) return true
  const target = slug.toLowerCase().trim()
  
  // Use admin client if available to bypass RLS for total accuracy
  const client = supabaseAdmin || supabase
  
  const { data, error } = await client
    .from(TABLE)
    .select('id, name, slug')
    .eq('slug', target)
    .limit(1)
  
  if (error) {
    console.error('[isSlugAvailable] DB Error:', error)
    return false // Assume taken on error for safety
  }
  
  const isAvailable = !data || data.length === 0
  console.log(`[isSlugAvailable] Slug "${target}" Check: ${isAvailable ? 'AVAILABLE' : 'TAKEN'}`)
  return isAvailable
}

// ── Create restaurant ─────────────────────────────────────────────────────────
export async function createRestaurant({ name, slug }) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ name, slug: slug.toLowerCase().trim() })
    .select()
    .single()
  if (error) throw error
  return data
}

// ── Toggle restaurant active/inactive ─────────────────────────────────────────
// When disabling: bans ALL users (admin + waiter) and force-logs them out
// When enabling: unbans ALL users so they can log back in
export async function toggleRestaurantStatus(restaurantId, setActive) {
  if (!supabaseAdmin) throw new Error('Service role key not configured.')

  // 1. Update restaurant is_active flag
  const { error } = await supabaseAdmin
    .from(TABLE)
    .update({ is_active: setActive })
    .eq('id', restaurantId)
  if (error) throw error

  // 2. Collect ALL user IDs for this restaurant from BOTH sources
  //    (profiles table might be missing some, auth.users metadata is authoritative)
  const userIds = new Set()

  // Source A: profiles table
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, role')
    .eq('restaurant_id', restaurantId)

  if (profiles) {
    profiles.forEach(p => {
      if (p.role !== 'super_admin') userIds.add(p.id)
    })
  }

  // Source B: auth.users via admin API (checks user_metadata.restaurant_id)
  try {
    let page = 1
    let hasMore = true
    while (hasMore) {
      const { data: { users: authUsers }, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: 100,
      })
      if (listErr || !authUsers || authUsers.length === 0) {
        hasMore = false
        break
      }
      for (const u of authUsers) {
        const meta = u.user_metadata || {}
        if (meta.restaurant_id === restaurantId && meta.role !== 'super_admin') {
          userIds.add(u.id)
        }
      }
      if (authUsers.length < 100) hasMore = false
      else page++
    }
  } catch (err) {
    console.warn('Could not list auth users, relying on profiles table only:', err)
  }

  // 3. Ban or unban each user + upsert profiles.is_disabled
  const isDisabled = setActive ? false : true
  console.log(`[toggleRestaurantStatus] ${setActive ? 'Enabling' : 'Disabling'} ${userIds.size} user(s) for restaurant ${restaurantId}`)
  for (const uid of userIds) {
    try {
      const { data: authData } = await supabaseAdmin.auth.admin.updateUserById(uid, {
        ban_duration: setActive ? 'none' : '876000h',
      })
      // Upsert profile so client polling detects it (handles missing rows)
      const email = authData?.user?.email || ''
      const role = authData?.user?.user_metadata?.role || 'waiter'
      const { error: pErr } = await supabaseAdmin
        .from('profiles')
        .upsert({
          id: uid,
          email,
          role,
          restaurant_id: restaurantId,
          is_disabled: isDisabled,
        }, { onConflict: 'id' })
      if (pErr) console.error(`[toggleRestaurantStatus] profile upsert failed for ${uid}:`, pErr)
      else console.log(`[toggleRestaurantStatus] profile.is_disabled=${isDisabled} for ${uid}`)
    } catch (err) {
      console.warn(`Could not ${setActive ? 'unban' : 'ban'} user ${uid}:`, err)
    }
  }

  // 4. Broadcast real-time force-logout signal (instant kick)
  if (!setActive) {
    await broadcastForceLogout(null, restaurantId)
  }
}


export async function isEmailAvailable(email) {
  if (!email) return true
  const cleanEmail = email.trim().toLowerCase()
  
  // 1. Check via Supabase Auth Admin API (Primary)
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserByEmail(cleanEmail)
      if (data?.user) {
        console.log(`[isEmailAvailable] Found in Auth: ${cleanEmail}`)
        return false
      }
      if (error && error.status !== 404 && !error.message?.includes('not found')) {
        console.error('[isEmailAvailable] Auth Error:', error)
      }
    } catch (err) {
      console.error('[isEmailAvailable] Auth catch:', err)
    }
  }

  // 2. Fallback: Check via Public Profiles table (Secondary)
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle()
    
    if (data) {
      console.log(`[isEmailAvailable] Found in Profiles: ${cleanEmail}`)
      return false
    }
    if (error) console.error('[isEmailAvailable] Profiles Error:', error)
  } catch (err) {
    console.error('[isEmailAvailable] Profiles catch:', err)
  }

  return true
}

// ── Create user (admin/waiter) via GoTrue Admin API ───────────────────────────
export async function createUser({ email, password, role, restaurantId }) {
  if (!supabaseAdmin) {
    throw new Error('Service role key not configured. Add VITE_SUPABASE_SERVICE_ROLE_KEY to your .env file.')
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // Auto-confirm the user
    user_metadata: {
      role,
      restaurant_id: restaurantId,
    },
  })

  if (error) throw error

  // Safety net: explicitly upsert into profiles table
  // The DB trigger should do this, but sometimes metadata isn't available at trigger time
  const userId = data.user.id
  await supabaseAdmin.from('profiles').upsert({
    id: userId,
    email,
    role,
    restaurant_id: restaurantId || null,
  }, { onConflict: 'id' })

  return userId
}

// ── Get users for a restaurant ────────────────────────────────────────────────
export async function getRestaurantUsers(restaurantId = null) {
  const { data, error } = await supabase.rpc('get_restaurant_users', {
    p_restaurant_id: restaurantId,
  })
  if (error) throw error
  return data || []
}

// ── Reset password ────────────────────────────────────────────────────────────
export async function resetUserPassword(userId, newPassword) {
  if (!supabaseAdmin) throw new Error('Service role key not configured.')
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  })
  if (error) throw error
}

// ── Broadcast a force-logout signal via Supabase Realtime ─────────────────────
// Target clients listen on this channel and sign out when they receive the signal
async function broadcastForceLogout(targetUserId, targetRestaurantId) {
  const channel = supabase.channel('force-logout-signals')
  await channel.subscribe()
  await channel.send({
    type: 'broadcast',
    event: 'force-logout',
    payload: {
      user_id: targetUserId || null,
      restaurant_id: targetRestaurantId || null,
      timestamp: Date.now(),
    },
  })
  // Small delay to ensure delivery, then cleanup
  setTimeout(() => supabase.removeChannel(channel), 2000)
}

// ── Disable / Enable individual user ──────────────────────────────────────────
export async function toggleUserStatus(userId, disable) {
  if (!supabaseAdmin) throw new Error('Service role key not configured.')

  // 1. Ban/unban in Supabase Auth
  const { data: authData, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    ban_duration: disable ? '876000h' : 'none',
  })
  if (error) throw error

  // 2. Upsert profiles.is_disabled so client polling detects it INSTANTLY
  //    Using upsert because the profile row might not exist for old waiters
  const isDisabled = disable ? true : false
  const email = authData?.user?.email || ''
  const role = authData?.user?.user_metadata?.role || 'waiter'
  const restaurantId = authData?.user?.user_metadata?.restaurant_id || null

  console.log(`[toggleUserStatus] Setting is_disabled=${isDisabled} for user ${userId} (${email})`)

  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .upsert({
      id: userId,
      email: email,
      role: role,
      restaurant_id: restaurantId,
      is_disabled: isDisabled,
    }, { onConflict: 'id' })

  if (profileErr) {
    console.error('[toggleUserStatus] Profile upsert failed:', profileErr)
  } else {
    console.log('[toggleUserStatus] Profile upsert success: is_disabled =', isDisabled)
  }

  // 3. Broadcast as backup for real-time kick
  if (disable) {
    await broadcastForceLogout(userId, null)
  }
}

// ── Force logout ──────────────────────────────────────────────────────────────
// Invalidates sessions by rotating the user's password internally (then resetting it)
// This forces all existing refresh tokens to become invalid
export async function forceLogout({ userId, restaurantId }) {
  if (!supabaseAdmin) throw new Error('Service role key not configured.')

  let count = 0

  if (userId) {
    // Invalidate the user's existing sessions by updating their metadata
    // This triggers a token refresh which will fail if they're banned
    try {
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        app_metadata: { force_logout_at: Date.now() },
      })
      count = 1
    } catch {
      count = 1
    }
    // Broadcast real-time signal for instant client-side logout
    await broadcastForceLogout(userId, null)
  } else if (restaurantId) {
    // Force logout ALL users of a restaurant
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('restaurant_id', restaurantId)

    if (profiles) {
      for (const p of profiles) {
        try {
          await supabaseAdmin.auth.admin.updateUserById(p.id, {
            app_metadata: { force_logout_at: Date.now() },
          })
        } catch { /* best effort */ }
        count++
      }
    }
    // Broadcast real-time signal with restaurant scope
    await broadcastForceLogout(null, restaurantId)
  }

  return count
}

// ── Delete user (auth + profiles table) ───────────────────────────────────────
export async function deleteUser(userId) {
  if (!supabaseAdmin) throw new Error('Service role key not configured.')

  // 1. Remove from profiles table first (so FK constraints don't block)
  await supabaseAdmin.from('profiles').delete().eq('id', userId)

  // 2. Remove from Supabase Auth
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId)
  if (error) throw error
}

// ── Delete restaurant (full cascade) ──────────────────────────────────────────
// Removes all associated data: menu items + images, orders, config, users, then restaurant
export async function deleteRestaurant(restaurantId) {
  if (!supabaseAdmin) throw new Error('Service role key not configured.')
  if (!restaurantId) throw new Error('Restaurant ID is required.')

  // 1. Delete menu images from storage
  const { data: menuItems } = await supabaseAdmin
    .from('menu')
    .select('image_url')
    .eq('restaurant_id', restaurantId)

  if (menuItems) {
    for (const item of menuItems) {
      if (item.image_url) {
        try { await deleteMenuImage(item.image_url) } catch { /* best-effort */ }
      }
    }
  }

  // 2. Delete menu items
  await supabaseAdmin.from('menu').delete().eq('restaurant_id', restaurantId)

  // 3. Delete order_items (if they reference orders via FK)
  const { data: orderRows } = await supabaseAdmin
    .from('orders')
    .select('id')
    .eq('restaurant_id', restaurantId)

  if (orderRows && orderRows.length > 0) {
    const orderIds = orderRows.map(o => o.id)
    // Delete in batches to avoid payload limits
    for (let i = 0; i < orderIds.length; i += 100) {
      const batch = orderIds.slice(i, i + 100)
      await supabaseAdmin.from('order_items').delete().in('order_id', batch)
    }
  }

  // 4. Delete orders
  await supabaseAdmin.from('orders').delete().eq('restaurant_id', restaurantId)

  // 5. Delete config row(s)
  await supabaseAdmin.from('config').delete().eq('restaurant_id', restaurantId)

  // 6. Delete all users (profiles + auth) belonging to this restaurant
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('restaurant_id', restaurantId)

  if (profiles) {
    for (const p of profiles) {
      try {
        await supabaseAdmin.from('profiles').delete().eq('id', p.id)
        await supabaseAdmin.auth.admin.deleteUser(p.id)
      } catch {
        console.warn('Could not delete user:', p.id)
      }
    }
  }

  // 7. Delete the restaurant row itself
  const { error } = await supabaseAdmin.from('restaurants').delete().eq('id', restaurantId)
  if (error) throw error
}

/**
 * ── Real-time subscription to Restaurants ─────────────────────────────────────
 * Listens for INSERT, UPDATE, DELETE on the 'restaurants' table.
 */
export function subscribeToRestaurants(onChange) {
  const channelName = `realtime-restaurants-${Date.now()}`
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (payload) => {
      console.log('[Supabase] REALTIME restaurant change:', payload)
      onChange(payload)
    })
    .subscribe()

  return () => supabase.removeChannel(channel)
}

/**
 * ── Real-time subscription to Profiles (Users) ────────────────────────────────
 * Useful for Super Admin to see instant changes in user roles or status.
 */
export function subscribeToProfiles(onChange, restaurantId = null) {
  const channelName = `realtime-profiles-${Date.now()}`
  const filter = restaurantId 
    ? { event: '*', schema: 'public', table: 'profiles', filter: `restaurant_id=eq.${restaurantId}` }
    : { event: '*', schema: 'public', table: 'profiles' }

  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', filter, (payload) => {
      console.log('[Supabase] REALTIME profile change:', payload)
      onChange(payload)
    })
    .subscribe()

  return () => supabase.removeChannel(channel)
}

/**
 * ── Generate a secure impersonation link for a restaurant's admin ─────────────
 * Finds the admin user for the given restaurant and creates a magic link
 * restricted for Super Admin use.
 */
export async function getImpersonationLink(restaurantId) {
  if (!supabaseAdmin) throw new Error('Service role key not configured.')

  // 1. Find the admin user ID for this restaurant
  const { data: users, error: rpcErr } = await supabase.rpc('get_restaurant_users', {
    p_restaurant_id: restaurantId,
  })
  if (rpcErr) throw rpcErr

  const targetAdmin = users?.find(u => u.role === 'admin')
  if (!targetAdmin) throw new Error('No admin user found for this restaurant.')

  // 2. Fetch the restaurant slug to create a direct redirect
  const { data: rest, error: restErr } = await supabase
    .from('restaurants')
    .select('slug')
    .eq('id', restaurantId)
    .single()
  if (restErr) throw restErr

  // 3. Generate a magic link using the Admin API
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: targetAdmin.email,
    options: {
      redirectTo: `${baseUrl}/${rest.slug}/admin`, // Direct landing
    }
  })

  if (error) throw error
  return data.properties.action_link
}
