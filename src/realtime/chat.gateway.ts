import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// Broadcasts to every connected dashboard client — no rooms/auth scoping,
// consistent with the dev-phase decision that every role sees everything.
// Frontend filters client-side (only appends messages for the open thread).
@Injectable()
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitNewMessage(message: Record<string, any>) {
    this.server?.emit('message:new', message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitConversationUpdated(conversation: Record<string, any>) {
    this.server?.emit('conversation:updated', conversation);
  }
}
