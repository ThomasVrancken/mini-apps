import axios from 'axios'

// One axios client for the whole app.
// - Shared-token tier: the access code lives in localStorage and is sent as
//   `Authorization: Bearer <code>`.
// - Firebase tier: call api.setTokenProvider(getIdToken) once (see
//   src/auth/firebase.js); a fresh ID token is then fetched per request.

const API_BASE = '/api'
export const TOKEN_STORAGE_KEY = 'SERVICE_NAME_token'
const API_CACHE_NAME = 'SERVICE_NAME-api-v1' // must match API_CACHE in public/sw.js
export const UNAUTHORIZED_EVENT = 'SERVICE_NAME:unauthorized'

// AI calls can legitimately take 10-60 s server side: give them 2 minutes.
const LONG_TIMEOUT = 120000
const DEFAULT_TIMEOUT = 15000

class ApiService {
  constructor() {
    this.tokenProvider = null
    this.client = axios.create({ baseURL: API_BASE, timeout: DEFAULT_TIMEOUT })

    this.client.interceptors.request.use(async (config) => {
      const token = this.tokenProvider ? await this.tokenProvider() : localStorage.getItem(TOKEN_STORAGE_KEY)
      if (token) config.headers.Authorization = `Bearer ${token}`
      return config
    })

    this.client.interceptors.response.use(
      (response) => response.data,
      (error) => {
        const status = error.response?.status
        const code = error.response?.data?.code
        // 401 = bad/expired credentials. Only specific 403 codes sign out;
        // a plain 403 (e.g. owner-only route) must not.
        if (status === 401 || (status === 403 && (code === 'account_disabled' || code === 'not_allowed'))) {
          if (!this.tokenProvider) localStorage.removeItem(TOKEN_STORAGE_KEY)
          this.clearApiCache()
          window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { message: error.response?.data?.error } }))
        }
        const wrapped = new Error(error.response?.data?.error || error.message || 'Something went wrong')
        wrapped.status = status
        throw wrapped
      }
    )
  }

  // --- auth -----------------------------------------------------------------

  setTokenProvider(fn) {
    this.tokenProvider = fn
  }

  setToken(token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
    // A new token may be a different identity: never show someone else's cached data.
    this.clearApiCache()
  }

  clearToken() {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    this.clearApiCache()
  }

  hasToken() {
    return Boolean(localStorage.getItem(TOKEN_STORAGE_KEY))
  }

  async clearApiCache() {
    if (typeof caches === 'undefined') return
    try {
      await caches.delete(API_CACHE_NAME)
    } catch {
      // ignore
    }
  }

  me() {
    return this.client.get('/me')
  }

  // --- items ----------------------------------------------------------------

  getItems(status) {
    return this.client.get('/items', { params: status ? { status } : {} })
  }

  createItem(item) {
    return this.client.post('/items', item)
  }

  updateItem(id, patch) {
    return this.client.patch(`/items/${id}`, patch)
  }

  deleteItem(id) {
    return this.client.delete(`/items/${id}`)
  }

  // --- preferences ----------------------------------------------------------

  getPreferences() {
    return this.client.get('/preferences')
  }

  updatePreferences(patch) {
    return this.client.put('/preferences', patch)
  }

  getPreferencesHistory() {
    return this.client.get('/preferences/history')
  }

  // --- chat -----------------------------------------------------------------

  getChat() {
    return this.client.get('/chat')
  }

  sendChat(message) {
    return this.client.post('/chat', { message }, { timeout: LONG_TIMEOUT })
  }

  clearChat() {
    return this.client.delete('/chat')
  }
}

export const api = new ApiService()
