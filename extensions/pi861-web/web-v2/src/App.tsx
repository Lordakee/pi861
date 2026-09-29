import React, { useState, useEffect, useRef, useCallback } from 'react'

// Page components (inline for single-file build)
import ChatPage from './pages/Chat'
import MissionPage from './pages/Mission'
import AgentsPage from './pages/Agents'
import ModelsPage from './pages/Models'
import SettingsPage from './pages/Settings'

type Page = 'chat'|'mission'|'agents'|'models'|'settings'
const NAV = [
  {id:'chat' as Page, label:'💬', text:'Chat'},
  {id:'mission' as Page, label:'🎯', text:'Mission Control'},
  {id:'agents' as Page, label:'🤖', text:'Agent Fleet'},
  {id:'models' as Page, label:'🧠', text:'Models'},
  {id:'settings' as Page, label:'⚙️', text:'Settings'},
]

export default function App() {
  const [page, setPage] = useState<Page>('chat')
  const [connected, setConnected] = useState(false)
  const [snapshot, setSnapshot] = useState<any>(null)
  const [token, setToken] = useState(localStorage.getItem('pi861_token') || '')
  const [showAuth, setShowAuth] = useState(!token)
  const wsRef = useRef<WebSocket|null>(null)

  const connect = useCallback((tok: string) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${tok}`)
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({type:'subscribe'})) }
    ws.onclose = () => { setConnected(false); setTimeout(()=>connect(tok), 3000) }
    ws.onmessage = (e) => {
      try { const data = JSON.parse(e.data)
        if (data.type === 'project.snapshot') setSnapshot(data.snapshot)
      } catch {}
    }
    wsRef.current = ws
  }, [])

  useEffect(() => { if (token) connect(token) }, [token, connect])

  if (showAuth) return <Auth onAuth={(t)=>{localStorage.setItem('pi861_token',t); setToken(t); setShowAuth(false)}}/>

  return (
    <div className="layout">
      <div className="topbar">
        <span className="logo">⚡ pi861</span>
        <div className="status">
          <span style={{fontSize:12,color:'var(--muted)'}}>{snapshot?.goal?.objective?.slice(0,50) || 'No goal'}</span>
          {connected
            ? <span className="badge badge-done">● Connected</span>
            : <span className="badge badge-blocked">● Reconnecting...</span>}
        </div>
      </div>
      <div className="sidebar">
        {NAV.map(item => (
          <button key={item.id} onClick={()=>setPage(item.id)}
            className={`nav-item ${page===item.id ? 'active' : ''}`}>
            <span style={{fontSize:16}}>{item.label}</span>
            <span>{item.text}</span>
          </button>
        ))}
      </div>
      <div className="main-content">
        {page==='chat' && <ChatPage ws={wsRef.current} connected={connected}/>}
        {page==='mission' && <MissionPage ws={wsRef.current} snapshot={snapshot}/>}
        {page==='agents' && <AgentsPage ws={wsRef.current} snapshot={snapshot}/>}
        {page==='models' && <ModelsPage snapshot={snapshot}/>}
        {page==='settings' && <SettingsPage ws={wsRef.current} snapshot={snapshot}/>}
      </div>
    </div>
  )
}

function Auth({ onAuth }: { onAuth:(t:string)=>void }) {
  const [token, setToken] = useState('')
  return (
    <div className="auth-overlay">
      <div className="card auth-card">
        <div style={{fontSize:40}}>⚡</div>
        <h2 style={{fontSize:20,fontWeight:700}}>pi861 Console</h2>
        <p style={{fontSize:13,color:'var(--muted)'}}>Enter your access token</p>
        <input className="input" type="password" placeholder="Token..." value={token} onChange={e=>setToken(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'&&token)onAuth(token)}} autoFocus/>
        <button className="btn btn-primary" onClick={()=>token&&onAuth(token)} disabled={!token} style={{width:'100%'}}>Connect</button>
      </div>
    </div>
  )
}
