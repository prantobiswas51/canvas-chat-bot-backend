import 'dotenv/config';
import { DataSource } from 'typeorm';
import { ChannelAccount, ChannelType } from '../chat/entities/channel-account.entity';
import { Customer } from '../chat/entities/customer.entity';
import { CustomerChannelIdentity } from '../chat/entities/customer-channel-identity.entity';
import { Conversation, ConversationStatus } from '../chat/entities/conversation.entity';
import { Message, MessageSender } from '../chat/entities/message.entity';

// One-time backfill for pre-app-launch Messenger history, via Meta's
// Conversations API. Safe to re-run — skips messages already saved (matched
// by externalMessageId), so it won't duplicate anything the live webhook
// already ingested.
//
// HARD LIMIT (Meta's, not ours): message *details* (sender/content/time) can
// only be retrieved for the 20 most recent messages in each conversation —
// anything older than that is not accessible via this API at all.
//
//   npm run backfill:messenger-history

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? 'canvas',
  password: process.env.POSTGRES_PASSWORD ?? 'canvas',
  database: process.env.POSTGRES_DB ?? 'canvas_chat_bot',
  entities: [ChannelAccount, Customer, CustomerChannelIdentity, Conversation, Message],
  synchronize: false,
});

const API_VERSION = process.env.WA_GRAPH_API_VERSION ?? 'v21.0';
const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

interface GraphConversationRef {
  id: string;
  updated_time: string;
}
interface GraphMessageRef {
  id: string;
  created_time: string;
}
interface GraphMessageDetail {
  id: string;
  created_time: string;
  from?: { id: string };
  to?: { data?: Array<{ id: string }> };
  message?: string;
}
interface GraphPaged<T> {
  data: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Graph API ${path} failed (${res.status}): ${errText}`);
  }
  return res.json() as Promise<T>;
}

function fallbackCustomerName(externalUserId: string): string {
  return `Customer •${externalUserId.slice(-4)}`;
}

async function getUserProfileName(psid: string): Promise<string | undefined> {
  try {
    const data = await graphGet<{ first_name?: string; last_name?: string }>(`/${psid}`, {
      fields: 'first_name,last_name',
      access_token: PAGE_TOKEN!,
    });
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
    return name || undefined;
  } catch {
    return undefined; // Business Asset User Profile Access not approved / token stale — non-fatal.
  }
}

async function run() {
  if (!PAGE_ID || !PAGE_TOKEN) {
    console.error('FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN not set in .env — nothing to do.');
    process.exit(1);
  }

  await dataSource.initialize();
  const channelAccountRepo = dataSource.getRepository(ChannelAccount);
  const customerRepo = dataSource.getRepository(Customer);
  const identityRepo = dataSource.getRepository(CustomerChannelIdentity);
  const conversationRepo = dataSource.getRepository(Conversation);
  const messageRepo = dataSource.getRepository(Message);

  const channelAccount = await channelAccountRepo.findOne({
    where: { channel: ChannelType.MESSENGER, externalAccountId: PAGE_ID },
  });
  if (!channelAccount) {
    console.error('No channel_accounts row for this Page — run "npm run setup:messenger-channel" first.');
    process.exit(1);
  }

  let totalConversations = 0;
  let totalMessages = 0;
  let cursor: string | undefined;
  let hasNext = true;

  while (hasNext) {
    const params: Record<string, string> = { platform: 'messenger', access_token: PAGE_TOKEN };
    if (cursor) params.after = cursor;

    const page = await graphGet<GraphPaged<GraphConversationRef>>(`/${PAGE_ID}/conversations`, params);

    for (const conv of page.data) {
      totalConversations += 1;

      const convDetail = await graphGet<{ messages?: { data: GraphMessageRef[] } }>(`/${conv.id}`, {
        fields: 'messages',
        access_token: PAGE_TOKEN,
      });

      // Meta returns newest-first; only the first 20 have retrievable details.
      const messageRefs = (convDetail.messages?.data ?? []).slice(0, 20);

      const details: GraphMessageDetail[] = [];
      let customerPsid: string | undefined;

      for (const ref of messageRefs) {
        const existing = await messageRepo.findOne({ where: { externalMessageId: ref.id } });
        if (existing) continue; // already ingested, e.g. via the live webhook

        try {
          const detail = await graphGet<GraphMessageDetail>(`/${ref.id}`, {
            fields: 'id,created_time,from,to,message',
            access_token: PAGE_TOKEN,
          });
          details.push(detail);

          const participantId = detail.from?.id === PAGE_ID ? detail.to?.data?.[0]?.id : detail.from?.id;
          if (participantId && participantId !== PAGE_ID) customerPsid = participantId;
        } catch (err) {
          console.warn(`Skipping message ${ref.id}: ${(err as Error).message}`);
        }
      }

      if (details.length === 0 || !customerPsid) continue;

      // Resolve/create the customer + conversation once per Messenger thread.
      const identity = await identityRepo.findOne({
        where: { channelAccountId: channelAccount.id, externalUserId: customerPsid },
        relations: { customer: true },
      });

      let customer: Customer;
      if (identity) {
        customer = identity.customer;
      } else {
        const resolvedName = await getUserProfileName(customerPsid);
        customer = await customerRepo.save(
          customerRepo.create({ name: resolvedName || fallbackCustomerName(customerPsid), tags: [] }),
        );
        await identityRepo.save(
          identityRepo.create({
            customerId: customer.id,
            channelAccountId: channelAccount.id,
            externalUserId: customerPsid,
          }),
        );
      }

      let conversation = await conversationRepo.findOne({
        where: { customerId: customer.id, channelAccountId: channelAccount.id },
        order: { createdAt: 'DESC' },
      });
      if (!conversation) {
        conversation = await conversationRepo.save(
          conversationRepo.create({
            customerId: customer.id,
            channelAccountId: channelAccount.id,
            channel: ChannelType.MESSENGER,
            status: ConversationStatus.AI_ACTIVE,
            unreadCount: 0,
          }),
        );
      }

      // Oldest first so the thread order and per-message timestamps come out right.
      const chronological = [...details].sort(
        (a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime(),
      );

      for (const detail of chronological) {
        const isFromPage = detail.from?.id === PAGE_ID;

        await messageRepo.save(
          messageRepo.create({
            conversationId: conversation.id,
            senderType: isFromPage ? MessageSender.HUMAN_AGENT : MessageSender.CUSTOMER,
            senderName: isFromPage ? 'Agent' : customer.name,
            content: detail.message ?? '[Unsupported message type]',
            externalMessageId: detail.id,
            createdAt: new Date(detail.created_time),
          }),
        );
        totalMessages += 1;
      }

      const last = chronological[chronological.length - 1];
      if (last) {
        conversation.lastMessage = last.message ?? conversation.lastMessage;
        conversation.lastMessageAt = new Date(last.created_time);
        await conversationRepo.save(conversation);
      }
    }

    hasNext = Boolean(page.paging?.next);
    cursor = page.paging?.cursors?.after;
  }

  console.log(`Backfilled ${totalMessages} messages across ${totalConversations} Messenger conversations.`);
  await dataSource.destroy();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
