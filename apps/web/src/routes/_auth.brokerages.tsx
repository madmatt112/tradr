import { createFileRoute } from '@tanstack/react-router';

import { BrokerageList } from '@/features/brokerages/components/BrokerageList';

export const Route = createFileRoute('/_auth/brokerages')({
  component: BrokerageList,
});
