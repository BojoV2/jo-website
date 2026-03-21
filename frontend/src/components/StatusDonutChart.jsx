import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const STATUS_CONFIG = [
  { key: 'done_count',        label: 'Done',        color: '#22c55e' },
  { key: 'pending_backlog',   label: 'Pending',      color: '#f0bc4c' },
  { key: 'rescheduled_count', label: 'Rescheduled',  color: '#ff9f43' },
  { key: 'cancelled_count',   label: 'Cancelled',    color: '#f06b7f' }
];

export default function StatusDonutChart({ analytics }) {
  const slices = analytics
    ? STATUS_CONFIG.map((s) => ({ name: s.label, value: analytics[s.key] || 0, color: s.color })).filter((d) => d.value > 0)
    : [];

  const total = slices.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="status-donut-card">
      <h3>Status Breakdown</h3>
      <p className="muted">This month's PDF outcomes for the selected template.</p>

      {total === 0 ? (
        <p className="muted status-donut-empty">No data for this month yet.</p>
      ) : (
        <>
          <div className="status-donut-wrap">
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={slices}
                  cx="50%"
                  cy="50%"
                  innerRadius={54}
                  outerRadius={82}
                  paddingAngle={2}
                  dataKey="value"
                  strokeWidth={0}
                  startAngle={90}
                  endAngle={-270}
                >
                  {slices.map((entry, index) => (
                    <Cell key={index} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: 'var(--paper)',
                    color: 'var(--ink)',
                    boxShadow: '0 6px 20px rgba(9,28,51,0.14)'
                  }}
                  formatter={(value, name) => [value, name]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="status-donut-center">
              <strong>{total}</strong>
              <span>Total</span>
            </div>
          </div>

          <div className="status-donut-legend">
            {STATUS_CONFIG.map((s) => {
              const value = analytics?.[s.key] || 0;
              const pct = total > 0 ? Math.round((value / total) * 100) : 0;
              return (
                <div key={s.key} className="status-donut-legend-row">
                  <span className="status-donut-dot" style={{ background: s.color }} />
                  <span className="status-donut-legend-label">{s.label}</span>
                  <span className="status-donut-legend-pct">{pct}%</span>
                  <strong className="status-donut-legend-val">{value}</strong>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
