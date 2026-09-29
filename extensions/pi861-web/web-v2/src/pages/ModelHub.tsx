import React from 'react'
import { Zap, DollarSign, Clock, HardDrive } from 'lucide-react'

export default function ModelHub({ snapshot }: { snapshot:any }) {
  const usage = snapshot?.usage || {}
  const budget = snapshot?.budget || {}
  const models = snapshot?.models || []
  const agents = snapshot?.agents || []
  const budgetPct = budget.limit ? Math.round(budget.used/budget.limit*100) : 0

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card p-5">
          <div className="flex items-center gap-2 text-muted text-xs uppercase tracking-wider mb-3"><Zap size={14}/> Requests</div>
          <p className="text-2xl font-bold tabular-nums">{usage.totalRequests || 0}</p>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-2 text-muted text-xs uppercase tracking-wider mb-3"><HardDrive size={14}/> Tokens</div>
          <p className="text-2xl font-bold tabular-nums">{((usage.inputTokens||0)+(usage.outputTokens||0)).toLocaleString()}</p>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-2 text-muted text-xs uppercase tracking-wider mb-3"><DollarSign size={14}/> Cost</div>
          <p className="text-2xl font-bold tabular-nums">${(usage.cost || 0).toFixed(4)}</p>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-2 text-muted text-xs uppercase tracking-wider mb-3"><Clock size={14}/> Budget</div>
          <p className="text-2xl font-bold tabular-nums">{budget.used}/{budget.limit}</p>
          <div className="progress-track mt-2"><div className="progress-fill" style={{width:`${budgetPct}%`}}/></div>
        </div>
      </div>

      {/* Model Cards */}
      <div className="card p-5">
        <h3 className="text-xs uppercase tracking-wider text-muted mb-4">Model Registry</h3>
        <div className="space-y-3">
          {models.map((model:any) => (
            <div key={model.id} className="flex items-center gap-4 p-3 rounded-lg border border-border">
              <div className={`status-dot ${model.healthy ? 'green' : 'red'}`}/>
              <div className="flex-1">
                <p className="text-sm font-medium">{model.name || model.id}</p>
                <p className="text-xs text-muted">{model.provider} · {model.contextWindow ? `${Math.round(model.contextWindow/1000)}k` : '?'} context</p>
              </div>
              <div className="text-right text-xs text-muted">
                <p>Q:{model.quality ?? '?'} C:{model.costRank ?? '?'}</p>
              </div>
              <span className={`badge ${model.enabled ? 'badge-done' : 'badge-queued'}`}>{model.enabled ? 'Active' : 'Disabled'}</span>
            </div>
          ))}
          {models.length === 0 && <p className="text-sm text-muted text-center py-4">No models configured</p>}
        </div>
      </div>

      {/* Agent-Model Matrix */}
      <div className="card p-5">
        <h3 className="text-xs uppercase tracking-wider text-muted mb-4">Agent Model Assignment</h3>
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-muted text-left border-b border-border">
            <th className="pb-2">Agent</th><th className="pb-2">Primary</th><th className="pb-2">Fallback</th><th className="pb-2">Status</th>
          </tr></thead>
          <tbody>
            {agents.map((agent:any) => (
              <tr key={agent.id} className="border-b border-border/50">
                <td className="py-2.5 font-medium">{agent.id}</td>
                <td className="py-2.5"><span className="badge badge-running">{agent.primaryModel || 'default'}</span></td>
                <td className="py-2.5"><span className="badge badge-queued">{agent.fallbackModels?.join(' → ') || 'none'}</span></td>
                <td className="py-2.5"><div className={`status-dot ${agent.status === 'busy' ? 'blue' : agent.status === 'online' ? 'green' : 'yellow'}`}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
