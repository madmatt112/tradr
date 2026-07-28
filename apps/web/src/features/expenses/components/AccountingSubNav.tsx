import { useNavigate } from '@tanstack/react-router';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type AccountingTab = 'expenses' | 'fee-rollup' | 'tax-summary';

interface AccountingSubNavProps {
  activeTab: AccountingTab;
}

export function AccountingSubNav({ activeTab }: AccountingSubNavProps) {
  const navigate = useNavigate();

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        navigate({ to: `/accounting/${value}` });
      }}
    >
      <TabsList>
        <TabsTrigger value="expenses" className="cursor-pointer">
          Expenses
        </TabsTrigger>
        <TabsTrigger value="fee-rollup" className="cursor-pointer">
          Fee Rollup
        </TabsTrigger>
        <TabsTrigger value="tax-summary" className="cursor-pointer">
          Tax Summary
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
