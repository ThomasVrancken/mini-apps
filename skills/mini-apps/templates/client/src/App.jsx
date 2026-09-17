import { useCallback, useEffect, useState } from 'react'
import { api, UNAUTHORIZED_EVENT } from './services/api'
import { AuthGate } from './components/AuthGate'

// App shell for the shared-token tier:
// 1. `/?code=<APP_TOKEN>` logs in automatically and strips the param from the URL.
// 2. Otherwise a stored token is verified with GET /api/me.
// 3. Otherwise show the access-code gate.
// Replace <Home /> with the real tabs (typically a fixed bottom tab bar).

function Home() {
  return (
    <div className="flex-1 overflow-y-auto px-4 pt-6 safe-top">
      <h1 className="text-2xl font-bold tracking-tight">APP_NAME</h1>
      <p className="text-ink-500 mt-2">You're in. Build the core loop from SPEC.md here.</p>
    </div>
  )
}

export default function App() {
  const [authState, setAuthState] = useState('checking') // checking | locked | unlocked
  const [authError, setAuthError] = useState(null)

  const tryAutoLogin = useCallback(async () => {
    const url = new URL(window.location.href)
    const codeParam = url.searchParams.get('code')
    if (codeParam) {
      api.setToken(codeParam)
      // Strip the secret from the address bar and history immediately.
      url.searchParams.delete('code')
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
      try {
        await api.me()
        setAuthState('unlocked')
      } catch {
        api.clearToken()
        setAuthError('That link has an invalid code.')
        setAuthState('locked')
      }
      return
    }
    if (api.hasToken()) {
      try {
        await api.me()
        setAuthState('unlocked')
        return
      } catch {
        api.clearToken()
      }
    }
    setAuthState('locked')
  }, [])

  useEffect(() => {
    tryAutoLogin()
  }, [tryAutoLogin])

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthError('Session expired. Enter your code again.')
      setAuthState('locked')
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  if (authState !== 'unlocked') {
    return (
      <AuthGate
        checking={authState === 'checking'}
        error={authError}
        onUnlocked={() => {
          setAuthError(null)
          setAuthState('unlocked')
        }}
      />
    )
  }

  return (
    <div className="h-[100dvh] bg-surface flex flex-col overflow-hidden">
      <Home />
    </div>
  )
}
