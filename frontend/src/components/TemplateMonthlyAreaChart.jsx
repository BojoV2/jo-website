import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

const colorPalette = [
  '#2b8cf2',
  '#37d9c4',
  '#f0bc4c',
  '#f06b7f',
  '#8a7dff',
  '#4fd38c',
  '#ff9f43',
  '#6ec1ff',
  '#ff7ab6',
  '#9bc53d'
];

const rangeOptions = [
  { value: '12', label: 'Last 12 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '3', label: 'Last 3 months' }
];

function makeSeriesKey(templateId) {
  return `template_${String(templateId).replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function formatMonthLabel(value) {
  if (!value) return '';
  const date = new Date(`${value}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function buildChartControlId(title) {
  return `monthly-chart-range-${String(title || 'chart').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export default function TemplateMonthlyAreaChart({
  monthlyReport,
  timeRange,
  onTimeRangeChange,
  title = 'Area Chart - Interactive',
  description = 'Monthly generated PDFs across all templates.',
  emptyText = 'No template report data yet.'
}) {
  const rangeSelectId = useMemo(() => buildChartControlId(title), [title]);
  const chartSeries = useMemo(
    () => monthlyReport.map((template, index) => ({
      key: makeSeriesKey(template.template_id),
      label: template.template_title,
      color: colorPalette[index % colorPalette.length]
    })),
    [monthlyReport]
  );

  const chartData = useMemo(() => {
    const rows = new Map();

    for (const template of monthlyReport) {
      const seriesKey = makeSeriesKey(template.template_id);
      for (const month of template.months || []) {
        if (!rows.has(month.month_key)) {
          rows.set(month.month_key, {
            monthKey: month.month_key,
            monthLabel: month.month_label
          });
        }
        rows.get(month.month_key)[seriesKey] = Number(month.total_generated || 0);
      }
    }

    return Array.from(rows.values())
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map((row) => {
        for (const series of chartSeries) {
          if (row[series.key] === undefined) {
            row[series.key] = 0;
          }
        }
        return row;
      });
  }, [chartSeries, monthlyReport]);

  return (
    <div className="monthly-area-chart">
      <div className="monthly-area-chart-head">
        <div>
          <h3>{title}</h3>
          <p className="muted">{description}</p>
        </div>
        <label className="monthly-area-chart-filter" htmlFor={rangeSelectId}>
          <span>Range</span>
          <select id={rangeSelectId} name="monthly_report_range" value={timeRange} onChange={(e) => onTimeRangeChange(e.target.value)}>
            {rangeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      {chartData.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <div className="monthly-area-chart-shell">
          <ResponsiveContainer width="100%" height={340}>
            <AreaChart data={chartData} margin={{ left: 8, right: 8, top: 12, bottom: 0 }}>
              <defs>
                {chartSeries.map((series) => (
                  <linearGradient key={`fill-${series.key}`} id={`fill-${series.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={series.color} stopOpacity={0.6} />
                    <stop offset="95%" stopColor={series.color} stopOpacity={0.06} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeOpacity={0.6} />
              <XAxis
                dataKey="monthKey"
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
                formatter={(value, name) => {
                  const series = chartSeries.find((item) => item.key === name);
                  return [Number(value || 0), series?.label || name];
                }}
                labelFormatter={(value) => formatMonthLabel(value)}
              />
              <Legend
                verticalAlign="top"
                align="left"
                wrapperStyle={{ paddingBottom: '18px' }}
                formatter={(value) => {
                  const series = chartSeries.find((item) => item.key === value);
                  return series?.label || value;
                }}
              />
              {chartSeries.map((series) => (
                <Area
                  key={series.key}
                  type="natural"
                  dataKey={series.key}
                  name={series.key}
                  stackId="templates"
                  stroke={series.color}
                  fill={`url(#fill-${series.key})`}
                  strokeWidth={2}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
