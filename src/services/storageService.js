// src/services/storageService.js
// Storage bucket monitoring — list files, calculate usage vs. free-tier limits

import { supabase, supabaseAdmin } from '../supabase/client'

const BUCKET = 'menu-images'

// Supabase free tier storage limit = 1 GB
const FREE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024

// Use admin client if available (to bypass RLS for total usage calculation)
const client = supabaseAdmin || supabase

// ── Recursively list all files in the bucket ──────────────────────────────────
async function listAllFiles(prefix = '') {
  const { data, error } = await client.storage
    .from(BUCKET)
    .list(prefix, { limit: 1000, offset: 0 })

  if (error) throw error
  if (!data) return []

  // Files have non-null ids. Folders have null ids.
  const files   = data.filter(f => f.id !== null && f.name !== '.emptyFolderPlaceholder')
  const folders = data.filter(f => f.id === null && f.name !== '.emptyFolderPlaceholder')

  // Recurse into sub-folders
  const nested = await Promise.all(
    folders.map(folder => listAllFiles(prefix ? `${prefix}/${folder.name}` : folder.name))
  )

  return [...files, ...nested.flat()]
}

// ── Get storage stats globally ────────────────────────────────────────────────
export async function getStorageStats() {
  const files = await listAllFiles()
  const usedBytes = files.reduce((sum, f) => sum + (f.metadata?.size || 0), 0)
  
  const usedMB  = usedBytes / (1024 * 1024)
  const limitMB = FREE_LIMIT_BYTES / (1024 * 1024)
  const usedPct = Math.min((usedBytes / FREE_LIMIT_BYTES) * 100, 100)

  return {
    usedBytes,
    limitBytes: FREE_LIMIT_BYTES,
    usedMB:     parseFloat(usedMB.toFixed(2)),
    limitMB:    parseFloat(limitMB.toFixed(2)),
    usedPct:    parseFloat(usedPct.toFixed(1)),
    fileCount:  files.length,
  }
}

// ── Get storage stats broken down by restaurant ──────────────────────────────
export async function getStorageStatsByRestaurant() {
  // 1. Fetch all menu items that have an image
  const { data: menuItems, error: dbErr } = await client
    .from('menu')
    .select('restaurant_id, image_url')
    .not('image_url', 'eq', '')
    .not('image_url', 'is', null)

  if (dbErr) throw dbErr

  // 2. List all actual files in storage
  const allFiles = await listAllFiles()
  
  // Create a map of filename -> size for quick lookup
  const sizeMap = new Map()
  allFiles.forEach(f => {
    sizeMap.set(f.name, f.metadata?.size || 0)
  })

  // 3. Aggregate by restaurant
  const stats = {} // { restaurantId: { usedBytes, fileCount } }

  menuItems.forEach(item => {
    const rid = item.restaurant_id
    if (!stats[rid]) stats[rid] = { usedBytes: 0, fileCount: 0 }

    // Extract filename from public URL
    // Format is usually .../storage/v1/object/public/menu-images/FILENAME
    try {
      const url = item.image_url
      const parts = url.split('/')
      const filename = parts[parts.length - 1]
      
      const size = sizeMap.get(filename) || 0
      if (size > 0) {
        stats[rid].usedBytes += size
        stats[rid].fileCount += 1
      }
    } catch (err) {
      console.warn('Could not parse image URL:', item.image_url)
    }
  })

  // 4. Format for UI
  const result = {}
  for (const rid in stats) {
    const usedBytes = stats[rid].usedBytes
    const usedMB = usedBytes / (1024 * 1024)
    result[rid] = {
      usedMB: parseFloat(usedMB.toFixed(2)),
      fileCount: stats[rid].fileCount,
      // We'll use a relative percentage or global percentage if needed
      usedPct: parseFloat(((usedBytes / FREE_LIMIT_BYTES) * 100).toFixed(2))
    }
  }

  return result
}
