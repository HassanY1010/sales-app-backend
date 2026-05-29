import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const allowedSocketOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
    ];

@Injectable()
@WebSocketGateway({
  cors: {
    origin: allowedSocketOrigins,
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger = new Logger('EventsGateway');
  // Map businessId to array of socketIds
  private activeSockets = new Map<string, string[]>();
  // Map admin role to array of socketIds
  private adminSockets = new Map<string, string[]>();

  constructor(private jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      const businessId = payload.businessId;
      const role = payload.role;

      client.data.businessId = businessId;
      client.data.role = role;

      // Admin sockets for receiving notifications
      if (role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'SUPPORT') {
        const adminSockets = this.adminSockets.get(role) || [];
        adminSockets.push(client.id);
        this.adminSockets.set(role, adminSockets);
        this.logger.log(`Admin ${role} connected: ${client.id}`);
      }

      // Business sockets
      if (businessId) {
        const userSockets = this.activeSockets.get(businessId) || [];
        userSockets.push(client.id);
        this.activeSockets.set(businessId, userSockets);
        this.logger.log(`Client connected: ${client.id} (Business: ${businessId})`);
      }
    } catch (e) {
      client.disconnect();
    }
  }

  private extractToken(client: Socket) {
    const authToken =
      typeof client.handshake.auth?.token === 'string' ? client.handshake.auth.token : undefined;
    const bearerToken =
      typeof client.handshake.headers.authorization === 'string'
        ? client.handshake.headers.authorization.split(' ')[1]
        : undefined;
    const cookieToken = this.getCookie(client, 'access_token');

    return authToken || bearerToken || cookieToken || '';
  }

  private getCookie(client: Socket, name: string) {
    const cookieHeader = client.handshake.headers.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') return undefined;

    return cookieHeader
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split('=')
      .slice(1)
      .join('=');
  }

  handleDisconnect(client: Socket) {
    const businessId = client.data.businessId;
    const role = client.data.role;

    if (role && (role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'SUPPORT')) {
      const adminSockets = this.adminSockets.get(role) || [];
      const index = adminSockets.indexOf(client.id);
      if (index > -1) {
        adminSockets.splice(index, 1);
        this.adminSockets.set(role, adminSockets);
      }
    }

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

  // Helper method to emit events to all admins
  emitToAllAdmins(event: string, payload: any) {
    const roles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
    roles.forEach((role) => {
      const sockets = this.adminSockets.get(role) || [];
      sockets.forEach((socketId) => {
        this.server.to(socketId).emit(event, payload);
      });
    });
  }

  emitToUserBusiness(businessId: string | null | undefined, payload: any) {
    if (!businessId) return;
    this.emitToBusiness(businessId, 'notification:new', payload);
  }

  // Helper method to emit events to specific admin role
  emitToRole(role: string, event: string, payload: any) {
    const sockets = this.adminSockets.get(role) || [];
    sockets.forEach((socketId) => {
      this.server.to(socketId).emit(event, payload);
    });
  }
}
