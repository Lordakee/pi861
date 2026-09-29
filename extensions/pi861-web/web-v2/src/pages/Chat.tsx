import React, { useState, useEffect, useRef } from 'react'

export default function Chat({ ws, connected }: { ws: WebSocket|null; connected: boolean }) {
  const [messages, setMessages] = useState<any[]>([])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(0)

  useEffect(() => {
    if (!ws) return
    const handler = (e: MessageEvent) => {
      try { const data = JSON.parse(e.data)
        if (data.type === 'chat.history') setMessages(data.messages || [])
        else if (data.type === 'chat.delta') {
          setMessages(prev => {
            const last = prev[prev.length-1]
            if (last?.role === 'assistant') return [...prev.slice(0,-1), {...last, content: last.content + data.text}]
            return [...prev, {id:`a${++idRef.current}`,role:'assistant',content:data.text,timestamp:Date.now()}]
          })
        } else if (data.type === 'chat.completed') setGenerating(false)
        else if (data.type === 'chat.error') setGenerating(false)
      } catch {}
    }
    ws.addEventListener('message', handler)
    return () => ws.removeEventListener('message', handler)
  }, [ws])

  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:'smooth'}) }, [messages])

  const send = () => {
    if (!input.trim() || !connected || generating) return
    ws?.send(JSON.stringify({type:'chat.send',text:input.trim()}))
    setMessages(prev=>[...prev,{id:`u${++idRef.current}`,role:'user',content:input.trim(),timestamp:Date.now()}])
    setInput(''); setGenerating(true)
  }
  const stop = () => { ws?.send(JSON.stringify({type:'chat.cancel'})); setGenerating(false) }

  return (
    <div className="chat-area">
      <div className="chat-messages">
        {messages.map(m=>(
          <div key={m.id} className={`msg-row ${m.role}`}>
            <div className={`msg ${m.role}`}>{m.content}</div>
          </div>
        ))}
        {generating && <div className="msg-row assistant"><div className="msg assistant typing-indicator"><span className="typing-dot"/><span className="typing-dot" style={{animationDelay:'0.2s'}}/><span className="typing-dot" style={{animationDelay:'0.4s'}}/></div></div>}
        <div ref={bottomRef}/>
      </div>
      <div className="chat-input">
        <input className="input" placeholder={connected?"Message pi861 agent...":"Connecting..."} value={input}
          onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}} disabled={!connected}/>
        {generating ? <button className="btn btn-danger" onClick={stop}>■ Stop</button> : <button className="btn btn-primary" onClick={send} disabled={!input.trim()||!connected}>Send</button>}
      </div>
    </div>
  )
}
