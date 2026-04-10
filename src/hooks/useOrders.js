// src/hooks/useOrders.js
// Real-time orders hook — supports restaurant_id filtering

import { useState, useEffect, useCallback } from 'react'
import {
  fetchOrders, placeOrder as svcPlace, fetchOrderByOrderId,
  updateOrderStatus, updateOrderItems as svcUpdateItems,
  deleteOrder as svcDelete,
  deleteAllOrders as svcDeleteAll,
  subscribeToOrders,
  normalise,
} from '../services/orderService'

export function useOrders(restaurantId) {
  const [orders,  setOrders]  = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!restaurantId) {
      setOrders([])
      setLoading(false)
      return
    }
    try {
      const data = await fetchOrders(restaurantId)
      setOrders(data)
    } catch (err) {
      console.error('useOrders fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [restaurantId])

  useEffect(() => {
    if (!restaurantId) {
      setOrders([])
      setLoading(false)
      return
    }
    load()
    
    // ── Instant Real-time ────────────────────────────────────────────
    const unsub = subscribeToOrders((payload) => {
      console.log('[useOrders] Change detected, refreshing instantly...')
      load() 
    }, restaurantId)

    return unsub
  }, [load, restaurantId])

  // ── Actions ────────────────────────────────────────────────────────────────
  const placeOrder = async (payload) => {
    const id = await svcPlace({ ...payload, restaurantId })
    load()
    return id
  }

  const getOrderByOrderId = (orderId) => fetchOrderByOrderId(orderId)

  const updateStatus = async (id, status) => {
    await updateOrderStatus(id, status)
    load()
  }

  const updateItems = async (id, items, subtotal, tax) => {
    await svcUpdateItems(id, items, subtotal, tax)
    load()
  }

  const deleteOrder = async (id) => {
    await svcDelete(id)
    load()
  }

  const deleteAllOrderHistory = async () => {
    await svcDeleteAll(restaurantId)
    load()
  }

  // ── Derived filter helpers ─────────────────────────────────────────────────
  const todayOrders = orders.filter(o => {
    if (!o.createdAt) return false
    return o.createdAt.toDateString() === new Date().toDateString()
  })

  const monthOrders = orders.filter(o => {
    if (!o.createdAt) return false
    const now = new Date()
    return (
      o.createdAt.getMonth()    === now.getMonth() &&
      o.createdAt.getFullYear() === now.getFullYear()
    )
  })

  return {
    orders, todayOrders, monthOrders, loading,
    placeOrder, getOrderByOrderId, updateStatus, updateItems, deleteOrder, deleteAllOrderHistory,
  }
}
