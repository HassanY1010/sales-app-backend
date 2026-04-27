import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger = new Logger('EventsGateway');
  // Map businessId to array of socketIds
  private activeSockets = new Map<string, string[]>();

  constructor(private jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.headers['authorization']?.split(' ')[1];
      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      const businessId = payload.businessId;

      if (!businessId) {
        client.disconnect();
        return;
      }

      client.data.businessId = businessId;

      const userSockets = this.activeSockets.get(businessId) || [];
      userSockets.push(client.id);
      this.activeSockets.set(businessId, userSockets);

      this.logger.log(`Client connected: ${client.id} (Business: ${businessId})`);
    } catch (e) {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const businessId = client.data.businessId;
    if (businessId) {
      const userSockets = this.activeSockets.get(businessId) || [];
      const index = userSockets.indexOf(client.id);
      if (index > -1) {
        userSockets.splice(index, 1);
        this.activeSockets.set(businessId, userSockets);
      }
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // Helper method to emit events to specific business
  emitToBusiness(businessId: string, event: string, payload: any) {
    const sockets = this.activeSockets.get(businessId);
    if (sockets && sockets.length > 0) {
      sockets.forEach((socketId) => {
        this.server.to(socketId).emit(event, payload);
      });
    }
  }
}
