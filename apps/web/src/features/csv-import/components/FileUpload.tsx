import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface FileUploadProps {
  file: File | null;
  onChange: (file: File | null) => void;
}

/**
 * Step 2 of the import flow (REQ-12.1): pick a CSV file. The browser does NOT
 * parse the CSV — the raw file is sent to the server (REQ-12 / tech.md). We only
 * capture the `File` here.
 */
export function FileUpload({ file, onChange }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-2">
      <Label htmlFor="import-file">CSV file</Label>
      <div className="flex items-center gap-3">
        <input
          ref={inputRef}
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="outline"
          className="cursor-pointer"
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </Button>
        <span className="text-sm text-muted-foreground">
          {file ? file.name : 'No file selected'}
        </span>
      </div>
    </div>
  );
}
