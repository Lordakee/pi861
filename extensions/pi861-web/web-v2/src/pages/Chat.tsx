import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Square, Wrench, ChevronDown, ChevronRight, Zap } from 'lucide-react'

interface Message { id: string; role: 'user'|'assistant'; content: string; model?: string; tools?: ToolCall[]; timestamp: number }
interface ToolCall { name: string; duration: number; result: string }

export default function Chat({ ws, connected }: { ws: WebSocket|null; connected: boolean }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [generating, setGenerating] = useState(false)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const bottomRef = useRef<HTMLDivElement>(null)
  const msgId = useRef(0)

  useEffect(() => {
    if (!ws) return
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.type === 'chat.history') {
        setMessages(data.messages || [])
      } else if (data.type === 'chat.delta') {
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: last.content + data.text }]
          }
          return [...prev, { id: `a${++msgId.current}`, role: 'assistant', content: data.text, model: data.model, timestamp: Date.now() }]
        })
      } else if (data.type === 'chat.completed') {
        setGenerating(false)
        if (data.tools) {
          setMessages(prev => {
            const last = prev[prev.length - 1]
            if (last) return [...prev.slice(0, -1), { ...last, tools: data.tools }]
            return prev
          })
        }
      } else if (data.type === 'chat.error') {
        setGenerating(false)
      }
    }
  }, [ws])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const send = () => {
    if (!input.trim() || !connected || generating) return
    const text = input.trim()
    setInput('')
    setMessages(prev => [...prev, { id: `u${++msgId.current}`, role: 'user', content: text, timestamp: Date.now() }])
    setGenerating(true)
    ws?.send(JSON.stringify({ type: 'chat.send', text }))
  }

  const stop = () => {
    ws?.send(JSON.stringify({ type: 'chat.cancel' }))
    setGenerating(false)
  }

  const toggleTool = (id: string) => {
    setExpandedTools(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed
              ${msg.role === 'user'
                ? 'bg-indigo-500 text-white rounded-br-md'
                : 'bg-panel border border-border rounded-bl-md'}`}>
              {msg.role === 'assistant' && msg.model && (
                <div className="flex items-center gap-1.5 mb-2 text-[11px] text-muted">
                  <Zap size={12} className="text-accent" />
                  <span>{msg.model}</span>
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
              {msg.tools && msg.tools.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.tools.map((tool, i) => {
                    const key = `${msg.id}-tool-${i}`
                    return (
                      <div key={key} className="border border-border rounded-lg overflow-hidden">
                        <button onClick={() => toggleTool(key)} className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted hover:text-text">
                          {expandedTools.has(key) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
                          <Wrench size={12}/>
                          <span className="flex-1 text-left">{tool.name}</span>
                          <span className="tabular-nums">{(tool.duration/1000).toFixed(1)}s</span>
                        </button>
                        {expandedTools.has(key) && (
                          <div className="px-3 py-2 text-xs bg-bg text-muted border-t border-border max-h-32 overflow-y-auto">
                            {tool.result}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
        {generating && (
          <div className="flex justify-start">
            <div className="bg-panel border border-border rounded-2xl rounded-bl-md px-4 py-3">
              <div className="flex gap-1.5 items-center h-6">
                <div className="typing-dot"/><div className="typing-dot"/><div className="typing-dot"/>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>
      <div className="border-t border-border bg-panel px-4 py-3">
        <div className="flex gap-2 max-w-3xl mx-auto">
          <input
            className="input flex-1"
            placeholder={connected ? "Message pi861 agent..." : "Connecting..."}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            disabled={!connected}
          />
          {generating ? (
            <button className="btn btn-danger" onClick={stop}><Square size={14}/> Stop</button>
          ) : (
            <button className="btn btn-primary" onClick={send} disabled={!input.trim() || !connected}>
              <Send size={14}/> Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
