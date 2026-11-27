'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useI18n } from '@/lib/i18n/useI18n';

export interface VelocityDataPoint {
  sprint: string;
  completed: number;
  planned: number;
}

interface VelocityChartProps {
  data: VelocityDataPoint[];
}

export function VelocityChart({ data }: VelocityChartProps) {
  const { t } = useI18n();
  if (data.length === 0) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="mb-4 text-sm font-medium">{t('Velocity')}</h3>
        <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
          {t('No sprint data available')}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-4 text-sm font-medium">{t('Velocity (tasks per sprint)')}</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis
            dataKey="sprint"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '6px',
              fontSize: '12px',
            }}
          />
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          <Bar dataKey="planned" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} name={t('Planned')} />
          <Bar dataKey="completed" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} name={t('Completed')} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
