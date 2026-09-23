import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { z, type ZodTypeAny } from 'zod';

import { WidgetDefaultSize } from '@tradr/shared/constants/dashboard-defaults';
import { PerWidgetMinSize, type WidgetType } from '@tradr/shared/schemas/dashboard';

export interface WidgetDefinition {
  type: WidgetType;
  displayName: string;
  // `any` props: individual widgets declare their own prop shapes (e.g.
  // PerformanceChartWidget takes `{ placement, onUpdateConfig }`). The route
  // (Task 43) is responsible for passing the right props per widget type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: LazyExoticComponent<ComponentType<any>>;
  minSize: { w: number; h: number };
  defaultSize: { w: number; h: number };
  defaultConfig?: unknown;
  configSchema?: ZodTypeAny;
}

export const widgetRegistry: Record<WidgetType, WidgetDefinition> = {
  'stats-summary': {
    type: 'stats-summary',
    displayName: 'Stats Summary',
    component: lazy(() => import('./StatsSummaryWidget')),
    minSize: PerWidgetMinSize['stats-summary'],
    defaultSize: WidgetDefaultSize['stats-summary'],
  },
  'open-positions': {
    type: 'open-positions',
    displayName: 'Open Positions',
    component: lazy(() => import('./OpenPositionsWidget')),
    minSize: PerWidgetMinSize['open-positions'],
    defaultSize: WidgetDefaultSize['open-positions'],
  },
  'performance-chart': {
    type: 'performance-chart',
    displayName: 'Performance Chart',
    component: lazy(() => import('./PerformanceChartWidget')),
    minSize: PerWidgetMinSize['performance-chart'],
    defaultSize: WidgetDefaultSize['performance-chart'],
    defaultConfig: { timeframe: 'monthly' },
    configSchema: z
      .object({
        timeframe: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'ytd', 'all-time']),
      })
      .strict(),
  },
  'account-balances': {
    type: 'account-balances',
    displayName: 'Account Balances',
    component: lazy(() => import('./AccountBalancesWidget')),
    minSize: PerWidgetMinSize['account-balances'],
    defaultSize: WidgetDefaultSize['account-balances'],
  },
  'position-sizing': {
    type: 'position-sizing',
    displayName: 'Position Sizing',
    component: lazy(() => import('./PositionSizingWidget')),
    minSize: PerWidgetMinSize['position-sizing'],
    defaultSize: WidgetDefaultSize['position-sizing'],
  },
  'equity-curve': {
    type: 'equity-curve',
    displayName: 'Equity Curve',
    component: lazy(() => import('./EquityCurveWidget')),
    minSize: PerWidgetMinSize['equity-curve'],
    defaultSize: WidgetDefaultSize['equity-curve'],
  },
};
