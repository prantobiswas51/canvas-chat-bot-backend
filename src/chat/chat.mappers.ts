import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';

// Shared DTO shaping — used by ChatService (HTTP responses) and WebhookService
// (real-time gateway emits) so both paths produce identical payload shapes.

// Mirrors the mock data's "10:42 AM" / "Aug 12"-ish formatting closely enough
// without pulling in a date library for this.
export function formatTimestamp(date: Date): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Requires the `customer` relation to be loaded on the conversation.
// `channelAccount` is optional — when loaded, its displayName lets the chat
// list show *which* connected Page/number a message came from (there can be
// several per channel type, e.g. two FB Pages both showing as "FB
// Messenger"), not just the generic channel type.
export function toConversationDto(c: Conversation) {
  return {
    id: c.id,
    channel: c.channel,
    channelAccountName: c.channelAccount?.displayName,
    status: c.status,
    assignedModeratorId: c.assignedModeratorId,
    adReferral: c.adReferral ?? undefined,
    unreadCount: c.unreadCount,
    lastMessage: c.lastMessage ?? '',
    lastMessageTime: formatTimestamp(c.lastMessageAt ?? c.createdAt),
    customer: {
      id: c.customer.id,
      name: c.customer.name,
      phone: c.customer.phone,
      email: c.customer.email,
      channel: c.channel,
      totalOrders: 0,
      totalSpent: 0,
      tags: c.customer.tags ?? [],
      notes: c.customer.notes ?? undefined,
    },
  };
}

export function toMessageDto(m: Message) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    sender: m.senderType,
    senderName: m.senderName ?? '',
    content: m.content,
    timestamp: formatTimestamp(m.createdAt),
    attachment: m.attachment,
  };
}
