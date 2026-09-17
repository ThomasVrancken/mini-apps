// Firebase Authentication client (tier 3: people sign up themselves).
// NOT YET BATTLE-TESTED in the example apps; see reference/firebase-auth.md.
//
//   cd client && npm install firebase
//
// The web config below is PUBLIC (it identifies the project, it is not a
// secret). Put it in client/.env.production / client/.env.local as VITE_*
// variables, or paste the values from `firebase apps:sdkconfig WEB <appId>`.
// Security comes from the server verifying ID tokens, not from hiding this.

import { initializeApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth'
import { api } from '../services/api'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, // PROJECT_ID.firebaseapp.com
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)

// Every API request gets a fresh ID token. getIdToken() returns the cached
// token and refreshes it automatically shortly before it expires (1 h).
api.setTokenProvider(async () => {
  const user = auth.currentUser
  return user ? user.getIdToken() : null
})

/** Subscribe to sign-in state. Returns the unsubscribe function. */
export function watchUser(callback) {
  return onAuthStateChanged(auth, callback)
}

export function signInWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider())
}

export function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password)
}

export function signUpWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password)
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email)
}

export async function logOut() {
  await api.clearApiCache() // never leave one user's cached data for the next
  return signOut(auth)
}

/** Friendly messages for the most common Firebase Auth error codes. */
export function authErrorMessage(err) {
  switch (err && err.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email or password is incorrect.'
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in.'
    case 'auth/weak-password':
      return 'Please use a password of at least 6 characters.'
    case 'auth/invalid-email':
      return 'That email address looks wrong.'
    case 'auth/popup-closed-by-user':
      return 'Sign-in was cancelled.'
    case 'auth/unauthorized-domain':
      return 'This domain is not authorized in Firebase Authentication settings.'
    default:
      return 'Could not sign in. Please try again.'
  }
}
