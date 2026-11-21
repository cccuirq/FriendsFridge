import { useEffect, useState, type FormEvent } from 'react'
import { AuthGate, getAuthToken, signOut, useAuthUser } from 'deepspace'
import { markup } from '../../fridge/markup'

declare global { interface Window { fridgeAuth: { getToken: typeof getAuthToken; signOut: typeof signOut } } }

async function profileRequest(method = 'GET', body?: Record<string,string>) {
  const token = await getAuthToken()
  const response = await fetch('/api/users/me', { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const result = await response.json() as { data?: unknown; error?: { code: string; message: string } }
  return { response, result }
}

function LegacyFridge() {
  useEffect(() => {
    window.fridgeAuth = { getToken: getAuthToken, signOut }
    if (document.querySelector('script[data-fridge-module]')) return
    const script = document.createElement('script')
    script.type = 'module'
    script.src = '/legacy/app.js'
    script.dataset.fridgeModule = 'true'
    script.onerror = () => {
      const notice = document.querySelector('#notice')
      if (notice) notice.textContent = 'The fridge could not load. Refresh to try again.'
    }
    document.body.appendChild(script)
  }, [])
  return <div data-testid="fridge-workspace" dangerouslySetInnerHTML={{ __html: markup }} />
}

function ProfileBoundary() {
  const { user } = useAuthUser()
  const [status,setStatus] = useState<'loading'|'onboarding'|'ready'|'error'>('loading')
  const [message,setMessage] = useState('')
  const [busy,setBusy] = useState(false)
  useEffect(() => {
    let active = true
    profileRequest().then(({response,result}) => {
      if (!active) return
      if (response.ok) setStatus('ready')
      else if (result.error?.code === 'PROFILE_REQUIRED') setStatus('onboarding')
      else { setMessage(result.error?.message || 'Could not load profile.'); setStatus('error') }
    }).catch(() => { if (active) { setMessage('Connection failed. Refresh to try again.'); setStatus('error') } })
    return () => { active = false }
  }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('')
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string,string>
    try {
      const { response,result } = await profileRequest('POST',data)
      if (!response.ok) throw new Error(result.error?.message || 'Could not create profile.')
      setStatus('ready')
    } catch(error) { setMessage(error instanceof Error ? error.message : 'Could not create profile.') }
    finally { setBusy(false) }
  }
  if (status === 'ready') return <LegacyFridge />
  return <main className="native-fridge-onboarding"><a className="wordmark" href="/">Friend's Fridge</a><section className="card">
    <h1>{status === 'onboarding' ? 'Your seat at the table.' : status === 'loading' ? 'Opening your fridge...' : 'Could not open your fridge'}</h1>
    {status === 'onboarding' && <><p>Choose the username your friends will search for. Your pantry stays private until you choose to share.</p>
    <form onSubmit={submit}>
      <label>Username<input name="username" pattern="[A-Za-z0-9_]{3,50}" minLength={3} maxLength={50} autoComplete="username" required /></label>
      <label>Display name<input name="display_name" maxLength={100} defaultValue={user?.fullName || ''} required /></label>
      <label>Contact email<input name="email" type="email" maxLength={255} defaultValue={user?.primaryEmailAddress?.emailAddress || ''} required /></label>
      <p className="muted">Sign-in stays with your DeepSpace Google/GitHub account.</p>
      <button disabled={busy} type="submit">{busy ? 'Setting your place...' : 'Open my fridge'}</button>
    </form></>}
    <p role="alert">{message}</p>
    {status === 'error' && <button onClick={() => location.reload()}>Try again</button>}
  </section></main>
}
export default function Home() {
  return <><title>Friend's Fridge | Your kitchen community</title><link rel="stylesheet" href="/legacy/styles.css" /><AuthGate><ProfileBoundary /></AuthGate></>
}
