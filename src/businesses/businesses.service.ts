import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class BusinessesService {
  constructor(private readonly prisma: PrismaService) {}

  async search(currentBusinessId: string, query: string) {
    const normalizedQuery = this.normalizeQuery(query);
    if (normalizedQuery.length < 2) {
      throw new BadRequestException('Query must contain at least 2 characters');
    }

    const businesses = await this.prisma.business.findMany({
      where: {
        id: { not: currentBusinessId },
        user: { isActive: true },
        OR: [
          { name: { contains: normalizedQuery } },
          { phoneNumber: { contains: normalizedQuery } },
          { email: { contains: normalizedQuery.toLowerCase() } },
          { user: { fullName: { contains: normalizedQuery } } },
          { user: { phoneNumber: { contains: normalizedQuery } } },
          { user: { email: { contains: normalizedQuery.toLowerCase() } } },
        ],
      },
      select: {
        id: true,
        name: true,
        businessType: true,
        phoneNumber: true,
        email: true,
        address: true,
        logoUrl: true,
        user: {
          select: {
            id: true,
            fullName: true,
            userType: true,
          },
        },
      },
      orderBy: { name: 'asc' },
      take: 10,
    });

    if (businesses.length === 0) return [];

    const existingConnections = await this.prisma.connection.findMany({
      where: {
        OR: businesses.flatMap((business) => [
          { requesterId: currentBusinessId, receiverId: business.id },
          { requesterId: business.id, receiverId: currentBusinessId },
        ]),
      },
      select: {
        id: true,
        requesterId: true,
        receiverId: true,
        status: true,
        connectionType: true,
      },
    });

    return businesses.map((business) => {
      const connection = existingConnections.find(
        (item) =>
          (item.requesterId === currentBusinessId &&
            item.receiverId === business.id) ||
          (item.requesterId === business.id &&
            item.receiverId === currentBusinessId),
      );

      let mappedConnection = null;
      if (connection) {
        const isRequester = connection.requesterId === currentBusinessId;
        mappedConnection = {
          ...connection,
          connectionType: isRequester
            ? connection.connectionType
            : connection.connectionType === 'CUSTOMER'
            ? 'SUPPLIER'
            : 'CUSTOMER',
        };
      }

      return {
        ...business,
        ownerName: business.user.fullName,
        userType: business.user.userType,
        connection: mappedConnection,
      };
    });
  }

  private normalizeQuery(query: string) {
    const trimmed = (query || '').trim();
    if (trimmed.includes('@')) return trimmed.toLowerCase();
    return trimmed.replace(/\D/g, '') || trimmed;
  }
}
