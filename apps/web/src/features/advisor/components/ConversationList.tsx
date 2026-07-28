// ConversationList — sidebar list of the user's conversations (REQ-1.1 left
// pane, REQ-1.9 list + delete, REQ-1.10 inline rename).
//
// The parent owns navigation: this component takes `activeId` (the currently
// open conversation, highlighted here) and an `onSelect(id)` callback fired
// when a row is clicked. It never reads or writes the URL/route itself.
//
// Delete requires an explicit inline confirm step — there is no auto-delete.
// Rename is an inline edit on the title via the rename mutation (Task 32).

import { formatDistanceToNow } from 'date-fns';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import {
  useConversations,
  useDeleteConversation,
  useRenameConversation,
} from '../hooks/useConversations';

export interface ConversationListProps {
  activeId: string | null;
  onSelect: (id: string) => void;
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

export function ConversationList({ activeId, onSelect }: ConversationListProps) {
  const { data, isLoading } = useConversations();
  const remove = useDeleteConversation();
  const rename = useRenameConversation();

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const conversations = data?.items ?? [];

  const startRename = (id: string, title: string) => {
    setEditingId(id);
    setDraftTitle(title);
  };

  const submitRename = async (id: string) => {
    const title = draftTitle.trim();
    try {
      if (title) {
        await rename.mutateAsync({ id, title });
      }
    } catch {
      toast.error("Couldn't rename conversation. Try again.");
    } finally {
      setEditingId(null);
    }
  };

  const onDelete = async (id: string) => {
    try {
      await remove.mutateAsync(id);
    } catch {
      toast.error("Couldn't delete conversation. Try again.");
    } finally {
      setConfirmingDeleteId(null);
    }
  };

  if (isLoading) {
    return <p className="p-3 text-sm text-muted-foreground">Loading conversations…</p>;
  }

  if (conversations.length === 0) {
    return <p className="p-3 text-sm text-muted-foreground">No conversations yet.</p>;
  }

  return (
    <ul className="space-y-1 p-2">
      {conversations.map((conversation) => {
        const isActive = conversation.id === activeId;
        const isEditing = editingId === conversation.id;

        return (
          <li key={conversation.id}>
            <div
              data-testid={`conversation-${conversation.id}`}
              className={cn(
                'group flex items-center gap-1 rounded-md px-2 py-1.5',
                isActive ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              {isEditing ? (
                <>
                  <Input
                    autoFocus
                    aria-label="Conversation title"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    className="h-7"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Save title"
                    className="size-7 cursor-pointer"
                    disabled={rename.isPending}
                    onClick={() => submitRename(conversation.id)}
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Cancel rename"
                    className="size-7 cursor-pointer"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="size-4" />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer text-left"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => onSelect(conversation.id)}
                  >
                    <span className="block truncate text-sm font-medium">{conversation.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {relativeTime(conversation.updatedAt)}
                    </span>
                  </button>

                  {confirmingDeleteId === conversation.id ? (
                    <>
                      <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        aria-label="Confirm delete"
                        className="size-7 cursor-pointer"
                        disabled={remove.isPending}
                        onClick={() => onDelete(conversation.id)}
                      >
                        <Check className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Cancel delete"
                        className="size-7 cursor-pointer"
                        onClick={() => setConfirmingDeleteId(null)}
                      >
                        <X className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Rename conversation"
                        className="size-7 cursor-pointer"
                        onClick={() => startRename(conversation.id, conversation.title)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Delete conversation"
                        className="size-7 cursor-pointer"
                        onClick={() => setConfirmingDeleteId(conversation.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
