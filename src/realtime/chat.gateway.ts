import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';

// Broadcasts to every connected dashboard client — no rooms/auth scoping,
// consistent with the dev-phase decision that every role sees everything.
// Frontend filters client-side (only appends messages for the open thread).
@Injectable()
@WebSocketGateway({
  cors: {
    // Function form (not a static string) purely so every handshake gets
    // logged — makes an Nginx-routing or FRONTEND_ORIGIN-mismatch problem
    // show up immediately in `pm2 logs` instead of just a silent client-side
    // "WebSocket connection failed" with no server-side trace at all.
    origin: (origin, callback) => {
      const logger = new Logger('ChatGateway/CORS');
      if (!origin || origin === FRONTEND_ORIGIN) {
        logger.log(`Handshake allowed — origin="${origin ?? '(none)'}"`);
        callback(null, true);
      } else {
        logger.warn(
          `Handshake REJECTED — origin="${origin}" does not match FRONTEND_ORIGIN="${FRONTEND_ORIGIN}". ` +
            `Fix FRONTEND_ORIGIN in .env if this origin is actually correct.`,
        );
        callback(null, false);
      }
    },
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  onModuleInit() {
    this.logger.log(`Socket.IO gateway ready — expecting requests to reach this process at /socket.io/ ` +
      `(check your reverse proxy routes that path here, with WebSocket upgrade headers set).`);

    // Fires for handshakes that fail *before* handleConnection would ever
    // run — wrong transport, timeout, bad Engine.IO version, etc. This is
    // the single most useful log line for "socket won't connect in prod"
    // since it runs even when Nginx/CORS never let the request through to
    // application logic at all.
    this.server.engine.on('connection_error', (err: { req?: { url?: string }; code?: number; message?: string; context?: unknown }) => {
      this.logger.warn(
        `Engine connection error — code=${err.code} message="${err.message}" url="${err.req?.url ?? 'unknown'}"`,
      );
    });
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id} (origin="${client.handshake.headers.origin ?? 'unknown'}")`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitNewMessage(message: Record<string, any>) {
    const clientCount = this.server?.engine?.clientsCount ?? 0;
    this.logger.log(`Emitting message:new (conversationId=${message.conversationId}) to ${clientCount} client(s)`);
    this.server?.emit('message:new', message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitConversationUpdated(conversation: Record<string, any>) {
    const clientCount = this.server?.engine?.clientsCount ?? 0;
    this.logger.log(`Emitting conversation:updated (id=${conversation.id}) to ${clientCount} client(s)`);
    this.server?.emit('conversation:updated', conversation);
  }
}
