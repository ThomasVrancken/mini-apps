import { useEffect, useState } from 'react'
import { api } from '../services/api'
import {
  authErrorMessage,
  logOut,
  resetPassword,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
  watchUser,
} from './firebase'

// Firebase tier sign-in screen + gate. Usage in App.jsx (instead of AuthGate):
//
//   <AccountGate>{(user) => <Home user={user} />}</AccountGate>
//
// After Firebase sign-in, GET /api/me makes the server verify the token and
// create the user doc on first login (and enforce ALLOWED_EMAILS if set).

export function AccountGate({ children }) {
  const [state, setState] = useState({ status: 'checking', user: null, error: null })

  useEffect(
    () =>
      watchUser(async (user) => {
        if (!user) return setState({ status: 'signedOut', user: null, error: null })
        try {
          await api.me()
          setState({ status: 'signedIn', user, error: null })
        } catch (err) {
          await logOut()
          setState({ status: 'signedOut', user: null, error: err.message })
        }
      }),
    []
  )

  if (state.status === 'checking') {
    return <div className="min-h-[100dvh] bg-surface flex items-center justify-center text-ink-500">Loading…</div>
  }
  if (state.status !== 'signedIn') return <SignIn initialError={state.error} />
  return children(state.user)
}

export function SignIn({ initialError }) {
  const [mode, setMode] = useState('signIn') // signIn | signUp
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError || null)
  const [info, setInfo] = useState(null)

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await fn()
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e) => {
    e.preventDefault()
    run(() => (mode === 'signIn' ? signInWithEmail(email.trim(), password) : signUpWithEmail(email.trim(), password)))
  }

  const forgot = () => {
    if (!email.trim()) return setError('Enter your email first.')
    run(async () => {
      await resetPassword(email.trim())
      setInfo('Check your inbox for a reset link.')
    })
  }

  const input =
    'w-full bg-white border border-ink-400/30 text-ink-800 text-base rounded-2xl px-4 py-3.5 outline-none mb-3 shadow-card focus:border-accent-400'

  return (
    <div className="min-h-[100dvh] bg-surface flex items-center justify-center px-6 safe-top safe-bottom">
      <div className="w-full max-w-xs text-center">
        <div className="text-6xl mb-4">✨</div>
        <h1 className="text-ink-800 text-2xl font-bold mb-6 tracking-tight">APP_NAME</h1>

        <button
          type="button"
          disabled={busy}
          onClick={() => run(signInWithGoogle)}
          className="w-full bg-white border border-ink-400/30 rounded-2xl py-3.5 font-semibold mb-4 shadow-card disabled:opacity-50"
        >
          Continue with Google
        </button>

        <form onSubmit={submit}>
          <input className={input} type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            className={input}
            type="password"
            autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-accent-600 text-sm mb-3">{error}</p>}
          {info && <p className="text-ink-500 text-sm mb-3">{info}</p>}
          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            className="w-full bg-accent-500 text-white rounded-2xl py-3.5 font-semibold disabled:opacity-50 shadow-card"
          >
            {busy ? 'Please wait…' : mode === 'signIn' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="mt-4 text-sm text-ink-500 space-x-3">
          <button type="button" onClick={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}>
            {mode === 'signIn' ? 'Create an account' : 'I already have an account'}
          </button>
          {mode === 'signIn' && (
            <button type="button" onClick={forgot}>
              Forgot password?
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
