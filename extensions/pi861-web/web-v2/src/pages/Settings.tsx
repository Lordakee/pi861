import React, { useState } from 'react'
import { Save, RefreshCw } from 'lucide-react'

export default function Settings({ ws, snapshot }: { ws:WebSocket|null; snapshot:any }) {
  const project = snapshot?.project || {}
  const [maxConcurrent, setMaxConcurrent] = useState(project.maxConcurrent || 2)
  const [reviewSlots, setReviewSlots] = useState(project.reviewSlots || 1)
  const [leaseMs, setLeaseMs] = useState(project.integrationLeaseMs || 120000)
  const [saved, setSaved] = useState(false)

  const save = () => {
    ws?.send(JSON.stringify({ type: 'settings.update', settings: { maxConcurrent, reviewSlots, integrationLeaseMs: leaseMs } }))
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="h-full overflow-y-auto p-6 max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold">Settings</h2>

      <div className="card p-6 space-y-5">
        <h3 className="text-xs uppercase tracking-wider text-muted">Team Configuration</h3>
        <div>
          <div className="flex justify-between text-sm mb-2"><span>Max Concurrent Workers</span><span className="text-accent font-semibold tabular-nums">{maxConcurrent}</span></div>
          <input type="range" min="1" max="8" value={maxConcurrent} onChange={e=>setMaxConcurrent(+e.target.value)} className="w-full accent-indigo-400"/>
        </div>
        <div>
          <div className="flex justify-between text-sm mb-2"><span>Review Slots</span><span className="text-accent font-semibold tabular-nums">{reviewSlots}</span></div>
          <input type="range" min="0" max="4" value={reviewSlots} onChange={e=>setReviewSlots(+e.target.value)} className="w-full accent-indigo-400"/>
        </div>
        <div>
          <label className="text-xs text-muted">Integration Lease TTL (ms)</label>
          <input type="number" className="input mt-1" value={leaseMs} onChange={e=>setLeaseMs(+e.target.value)} step="30000"/>
        </div>
      </div>

      <div className="card p-6 space-y-3">
        <h3 className="text-xs uppercase tracking-wider text-muted">Storage</h3>
        <div><label className="text-xs text-muted">State Directory</label>
          <input className="input mt-1" value={project.stateDirectory || '/mnt/d/pi-projects/android-app/.pi861-state'} readOnly/>
        </div>
      </div>

      <div className="card p-6 space-y-3">
        <h3 className="text-xs uppercase tracking-wider text-muted">Security</h3>
        <div className="flex items-center justify-between">
          <div><p className="text-sm">Console Token</p><p className="text-xs text-muted">Bearer token for API access</p></div>
          <button className="btn"><RefreshCw size={14}/> Rotate</button>
        </div>
      </div>

      <button className="btn btn-primary" onClick={save}><Save size={16}/> {saved ? 'Saved!' : 'Save Settings'}</button>
    </div>
  )
}
