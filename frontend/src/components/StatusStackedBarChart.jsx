import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

const STATUS_SERIES = [
  { key: 'cancelled',   label: 'Cancelled',   color: '#f06b7f' },
  { key: 'rescheduled', label: 'Rescheduled',  color: '#ff9f43' },
  { key: 'pending',     label: 'Pending',      color: '#f0bc4c' },
  { key: 'done',        label: 'Done',         color: '#22c55e' }
];

const rangeOptions = [
  { value: '12', label: 'Last 12 months' },
  { value: '6',  label: 'Last 6 months'  },
  { value: '3',  label: 'Last 3 months'  }
];

function formatMonthLabel(value) {
  if (!value) return '';
  const date = new Date(`${value}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export default function StatusStackedBarChart({
  monthlyData = [],
  timeRange,
  onTimeRangeChange,
  title = 'Monthly PDF Activity',
  description = 'Monthly generated PDFs broken down by outcome.',
  emptyText = 'No monthly data available yet.'
}) {
  return (
    <div className="monthly-area-chart">
      <div className="monthly-area-chart-head">
        <div>
          <h3>{title}</h3>
          <p className="muted">{description}</p>
        </div>
        <label className="monthly-area-chart-filter" htmlFor="status-bar-range">
          <span>Range</span>
          <select
            id="status-bar-range"
            value={timeRange}
            onChange={(e) => onTimeRangeChange(e.target.value)}
          >
            {rangeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      </div>

      {monthlyData.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <div className="monthly-area-chart-shell">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={monthlyData}
              margin={{ left: 8, right: 8, top: 12, bottom: 0 }}
              barCategoryGap="35%"
            >
              <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
              <XAxis
                dataKey="month_key"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                minTickGap={24}
                tickFormatter={formatMonthLabel}
                stroke="var(--muted)"
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                width={36}
                stroke="var(--muted)"
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 14,
                  border: '1px solid var(--line)',
                  background: 'var(--paper)',
                  color: 'var(--ink)',
                  boxShadow: '0 10px 30px rgba(9, 28, 51, 0.16)'
                }}
                labelFormatter={(value) => formatMonthLabel(value)}
              />
              <Legend
                verticalAlign="top"
                align="left"
                wrapperStyle={{ paddingBottom: '18px' }}
              />
              {STATUS_SERIES.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="status"
                  fill={s.color}
                  radius={i === STATUS_SERIES.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
