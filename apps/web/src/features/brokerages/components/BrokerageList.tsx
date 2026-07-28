import { useState } from 'react';

import type { Brokerage } from '@tradr/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useBrokerages } from '../hooks/useBrokerages';

function formatFeeSummary(brokerage: Brokerage): string {
  const parts: string[] = [];
  const stock = Number(brokerage.feeSchedule.stockPerShareCommission);
  const option = Number(brokerage.feeSchedule.optionsPerContractCommission);

  if (stock > 0) {
    parts.push(`$${brokerage.feeSchedule.stockPerShareCommission}/share`);
  }
  if (option > 0) {
    parts.push(`$${brokerage.feeSchedule.optionsPerContractCommission}/contract`);
  }
  if (parts.length === 0) {
    return 'No fees configured';
  }
  return parts.join(', ');
}

export function BrokerageList() {
  const { data: brokerages, isLoading } = useBrokerages();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editBrokerage, setEditBrokerage] = useState<Brokerage | null>(null);

  // Placeholder: dialog component is task 15
  void dialogOpen;
  void editBrokerage;

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Brokerages</h1>
        <Button
          className="cursor-pointer"
          onClick={() => {
            setEditBrokerage(null);
            setDialogOpen(true);
          }}
        >
          New Brokerage
        </Button>
      </div>

      {!brokerages?.length ? (
        <div className="py-12 text-center text-muted-foreground">
          No brokerages yet. Create one to start tracking fees.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Fee Summary</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {brokerages.map((brokerage) => (
              <TableRow key={brokerage.id}>
                <TableCell>
                  <div>
                    <span className="font-medium">{brokerage.name}</span>
                    {brokerage.isSystem && (
                      <p className="text-xs text-muted-foreground">
                        Approximate rates — verify with your broker
                      </p>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={brokerage.isSystem ? 'secondary' : 'outline'}>
                    {brokerage.isSystem ? 'System' : 'Custom'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatFeeSummary(brokerage)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" className="cursor-pointer">
                        ⋯
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {brokerage.isSystem ? (
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onClick={() => {
                            setEditBrokerage(brokerage);
                            setDialogOpen(true);
                          }}
                        >
                          View
                        </DropdownMenuItem>
                      ) : (
                        <>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => {
                              setEditBrokerage(brokerage);
                              setDialogOpen(true);
                            }}
                          >
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem className="cursor-pointer text-destructive">
                            Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
