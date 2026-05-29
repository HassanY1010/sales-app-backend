import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Readable } from 'stream';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // FIX BACKUP-01: Validate required encryption key at startup to prevent silent failures
    const encryptionKey = this.config.get<string>('BACKUP_TOKEN_ENCRYPTION_KEY');
    if (!encryptionKey || encryptionKey.length < 32) {
      this.logger.warn(
        '⚠️  BACKUP_TOKEN_ENCRYPTION_KEY is missing or too short (must be ≥32 chars). ' +
        'Google Drive backup/restore will fail. Set this env variable before using backup features.',
      );
    } else {
      this.logger.log('✅ BackupService initialized with valid encryption key.');
    }
  }


  async exportData(businessId: string) {
    this.logger.log(`Exporting data for business: ${businessId}`);
    try {
      const [business, users, connections, accounts, orders, transactions, notifications] = await Promise.all([
        this.prisma.business.findUnique({ where: { id: businessId } }),
        this.prisma.user.findMany({
          where: { business: { id: businessId } },
          select: {
            id: true,
            email: true,
            fullName: true,
            phoneNumber: true,
            userType: true,
            role: true,
            isEmailVerified: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        this.prisma.connection.findMany({
          where: { OR: [{ requesterId: businessId }, { receiverId: businessId }] },
          include: { account: true },
        }),
        this.prisma.account.findMany({
          where: { connection: { OR: [{ requesterId: businessId }, { receiverId: businessId }] } },
        }),
        this.prisma.order.findMany({
          where: { OR: [{ senderId: businessId }, { receiverId: businessId }] },
          include: { items: true },
        }),
        this.prisma.transaction.findMany({
          where: { OR: [{ senderId: businessId }, { receiverId: businessId }] },
        }),
        this.prisma.notification.findMany({
          where: { user: { business: { id: businessId } } },
        }),
      ]);

      return {
        version: 2,
        exportDate: new Date().toISOString(),
        businessId,
        data: {
          business,
          users,
          connections,
          accounts,
          orders,
          transactions,
          notifications,
        },
      };
    } catch (error) {
      this.logger.error(`Export failed: ${error.message}`);
      throw new InternalServerErrorException('فشل تصدير البيانات');
    }
  }

  async restoreData(businessId: string, backupData: any) {
    this.logger.log(`Restoring data for business: ${businessId}`);

    if (!backupData || backupData.businessId !== businessId) {
      throw new BadRequestException('ملف النسخ الاحتياطي لا يخص هذا الحساب');
    }

    this.validateBackupPayload(backupData);

    return this.prisma.$transaction(async (tx) => {
      const data = backupData.data || {};
      const stats = {
        business: 0,
        connections: 0,
        accounts: 0,
        orders: 0,
        orderItems: 0,
        transactions: 0,
        notifications: 0,
      };

      if (data.business?.id === businessId) {
        await tx.business.update({
          where: { id: businessId },
          data: this.pick(data.business, [
            'name',
            'businessType',
            'phoneNumber',
            'email',
            'address',
            'logoUrl',
          ]),
        });
        stats.business = 1;
      }

      for (const connection of data.connections || []) {
        if (connection.requesterId !== businessId && connection.receiverId !== businessId) continue;
        await tx.connection.upsert({
          where: { id: connection.id },
          create: this.pick(connection, [
            'id',
            'requesterId',
            'receiverId',
            'status',
            'connectionType',
            'showPrices',
            'blockedById',
            'lastRequestedAt',
            'retryCount',
            'createdAt',
            'updatedAt',
          ]) as any,
          update: this.pick(connection, [
            'status',
            'connectionType',
            'showPrices',
            'blockedById',
            'lastRequestedAt',
            'retryCount',
          ]),
        });
        stats.connections++;
      }

      const validConnectionIds = new Set(
        (await tx.connection.findMany({
          where: { OR: [{ requesterId: businessId }, { receiverId: businessId }] },
          select: { id: true },
        })).map((connection) => connection.id),
      );

      for (const account of data.accounts || []) {
        if (!validConnectionIds.has(account.connectionId)) continue;
        await tx.account.upsert({
          where: { connectionId: account.connectionId },
          create: this.pick(account, [
            'id',
            'connectionId',
            'balance',
            'totalCredit',
            'totalDebit',
            'creditLimit',
            'billingCycle',
            'currency',
            'dueDate',
          ]) as any,
          update: this.pick(account, [
            'balance',
            'totalCredit',
            'totalDebit',
            'creditLimit',
            'billingCycle',
            'currency',
            'dueDate',
          ]),
        });
        stats.accounts++;
      }

      for (const order of data.orders || []) {
        if (order.senderId !== businessId && order.receiverId !== businessId) continue;
        await tx.orderItem.deleteMany({ where: { orderId: order.id } });
        await tx.order.upsert({
          where: { id: order.id },
          create: this.pick(order, [
            'id',
            'orderNumber',
            'senderId',
            'receiverId',
            'status',
            'isCash',
            'currency',
            'dueDate',
            'pricesVisible',
            'priceAcceptedAt',
            'subtotal',
            'tax',
            'discount',
            'total',
            'notes',
            'rejectionReason',
            'rejectedById',
            'createdAt',
            'updatedAt',
          ]) as any,
          update: this.pick(order, [
            'status',
            'isCash',
            'currency',
            'dueDate',
            'pricesVisible',
            'priceAcceptedAt',
            'subtotal',
            'tax',
            'discount',
            'total',
            'notes',
            'rejectionReason',
            'rejectedById',
          ]),
        });
        stats.orders++;

        for (const item of order.items || []) {
          await tx.orderItem.create({
            data: this.pick(item, [
              'id',
              'orderId',
              'itemName',
              'description',
              'quantity',
              'unitPrice',
              'total',
              'unit',
            ]) as any,
          });
          stats.orderItems++;
        }
      }

      for (const transaction of data.transactions || []) {
        if (transaction.senderId !== businessId && transaction.receiverId !== businessId) continue;
        await tx.transaction.upsert({
          where: { id: transaction.id },
          create: this.pick(transaction, [
            'id',
            'transactionType',
            'voucherNumber',
            'amount',
            'currency',
            'dueDate',
            'attachmentUrl',
            'balanceAfter',
            'senderId',
            'receiverId',
            'orderId',
            'note',
            'createdAt',
          ]) as any,
          update: this.pick(transaction, [
            'transactionType',
            'voucherNumber',
            'amount',
            'currency',
            'dueDate',
            'attachmentUrl',
            'balanceAfter',
            'orderId',
            'note',
          ]),
        });
        stats.transactions++;
      }

      const userIds = (await tx.user.findMany({
        where: { business: { id: businessId } },
        select: { id: true },
      })).map((user) => user.id);

      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      for (const notification of data.notifications || []) {
        if (!userIds.includes(notification.userId)) continue;
        await tx.notification.create({
          data: this.pick(notification, [
            'id',
            'userId',
            'title',
            'body',
            'type',
            'isRead',
            'createdAt',
          ]) as any,
        });
        stats.notifications++;
      }

      await tx.auditLog.create({
        data: {
          businessId,
          action: 'RESTORE',
          resource: 'BACKUP',
          details: {
            version: backupData.version,
            exportDate: backupData.exportDate,
            collections: Object.keys(backupData.data || {}),
            stats,
          },
        },
      });

      return {
        success: true,
        message: 'تمت استعادة النسخة الاحتياطية بنجاح',
        stats,
      };
    });
  }

  getGoogleAuthUrl(businessId: string, redirectUri?: string) {
    const oauth2 = this.createOAuthClient(redirectUri);
    const state = Buffer.from(JSON.stringify({ businessId })).toString('base64url');

    return {
      authUrl: oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/userinfo.email',
        ],
        state,
      }),
      redirectUri: this.resolveRedirectUri(redirectUri),
    };
  }

  async connectGoogleDrive(
    businessId: string,
    userId: string | undefined,
    code: string,
    redirectUri?: string,
  ) {
    if (!code) {
      throw new BadRequestException('Google authorization code is required');
    }

    const oauth2 = this.createOAuthClient(redirectUri);
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      throw new BadRequestException('Google did not return a refresh token. Revoke app access and connect again.');
    }

    oauth2.setCredentials(tokens);
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const profile = await oauth2Api.userinfo.get();

    await this.prisma.cloudBackupCredential.upsert({
      where: { businessId },
      create: {
        businessId,
        refreshToken: this.encryptSecret(tokens.refresh_token),
        email: profile.data.email,
        scope: tokens.scope,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      },
      update: {
        refreshToken: this.encryptSecret(tokens.refresh_token),
        email: profile.data.email,
        scope: tokens.scope,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      },
    });

    await this.audit.record({
      userId,
      businessId,
      action: 'CONNECT',
      resource: 'GOOGLE_DRIVE_BACKUP',
      details: { email: profile.data.email, scope: tokens.scope },
    });

    return { connected: true, email: profile.data.email };
  }

  async getGoogleDriveStatus(businessId: string) {
    const credential = await this.prisma.cloudBackupCredential.findUnique({
      where: { businessId },
      select: { email: true, updatedAt: true },
    });

    return {
      connected: Boolean(credential),
      email: credential?.email,
      updatedAt: credential?.updatedAt,
    };
  }

  async uploadToGoogleDrive(businessId: string, userId?: string) {
    const backup = await this.exportData(businessId);
    const json = JSON.stringify(backup, null, 2);
    const fileName = `sales_app_backup_${businessId}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const drive = await this.createDriveClient(businessId);

    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'application/json',
        appProperties: {
          businessId,
          source: 'sales_app',
        },
      },
      media: {
        mimeType: 'application/json',
        body: Readable.from([json]),
      },
      fields: 'id,name,size,createdTime',
    });

    const checksum = createHash('sha256').update(json).digest('hex');
    const record = await this.prisma.cloudBackupRecord.create({
      data: {
        businessId,
        fileId: response.data.id!,
        fileName: response.data.name || fileName,
        fileSize: response.data.size ? Number(response.data.size) : Buffer.byteLength(json),
        checksum,
      },
    });

    await this.audit.record({
      userId,
      businessId,
      action: 'BACKUP_UPLOAD',
      resource: 'GOOGLE_DRIVE_BACKUP',
      resourceId: record.id,
      details: { fileId: record.fileId, fileName: record.fileName, checksum },
    });

    return record;
  }

  async listGoogleDriveBackups(businessId: string) {
    const drive = await this.createDriveClient(businessId);
    const response = await drive.files.list({
      q: "appProperties has { key='source' and value='sales_app' } and trashed=false",
      spaces: 'drive',
      fields: 'files(id,name,size,createdTime,modifiedTime)',
      orderBy: 'createdTime desc',
      pageSize: 50,
    });

    return response.data.files || [];
  }

  async restoreFromGoogleDrive(businessId: string, userId: string | undefined, fileId: string) {
    const drive = await this.createDriveClient(businessId);
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' },
    );

    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    const result = await this.restoreData(businessId, data);

    await this.audit.record({
      userId,
      businessId,
      action: 'RESTORE_FROM_DRIVE',
      resource: 'GOOGLE_DRIVE_BACKUP',
      resourceId: fileId,
    });

    return result;
  }

  private async createDriveClient(businessId: string) {
    const credential = await this.prisma.cloudBackupCredential.findUnique({ where: { businessId } });
    if (!credential) {
      throw new NotFoundException('Google Drive is not connected for this business');
    }

    const oauth2 = this.createOAuthClient();
    oauth2.setCredentials({ refresh_token: this.decryptSecret(credential.refreshToken) });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  private createOAuthClient(redirectUri?: string) {
    const clientId = this.config.get<string>('GOOGLE_DRIVE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_DRIVE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException('Google Drive OAuth is not configured');
    }

    return new google.auth.OAuth2(clientId, clientSecret, this.resolveRedirectUri(redirectUri));
  }

  private resolveRedirectUri(redirectUri?: string) {
    return redirectUri || this.config.get<string>('GOOGLE_DRIVE_REDIRECT_URI') || 'urn:ietf:wg:oauth:2.0:oob';
  }

  private pick(source: Record<string, any>, keys: string[]) {
    return keys.reduce<Record<string, any>>((acc, key) => {
      if (source[key] !== undefined) {
        acc[key] = source[key];
      }
      return acc;
    }, {});
  }

  private validateBackupPayload(backupData: any) {
    if (backupData.version !== 2) {
      throw new BadRequestException('Unsupported backup version');
    }

    if (!backupData.data || typeof backupData.data !== 'object') {
      throw new BadRequestException('Invalid backup payload');
    }

    for (const key of ['connections', 'accounts', 'orders', 'transactions', 'notifications']) {
      if (backupData.data[key] !== undefined && !Array.isArray(backupData.data[key])) {
        throw new BadRequestException(`Invalid backup collection: ${key}`);
      }
    }
  }

  private encryptSecret(value: string) {
    const key = this.getBackupEncryptionKey();
    if (!key) return value;

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      'enc:v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  private decryptSecret(value: string) {
    if (!value.startsWith('enc:v1:')) {
      if (process.env.NODE_ENV === 'production') {
        throw new InternalServerErrorException('Stored Google Drive credential is not encrypted');
      }
      return value;
    }

    const key = this.getBackupEncryptionKey();
    if (!key) {
      throw new InternalServerErrorException('BACKUP_TOKEN_ENCRYPTION_KEY is required to decrypt Google Drive credentials');
    }

    const [, , ivPart, tagPart, encryptedPart] = value.split(':');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private getBackupEncryptionKey() {
    const configured = this.config.get<string>('BACKUP_TOKEN_ENCRYPTION_KEY');
    if (!configured) {
      if (process.env.NODE_ENV === 'production') {
        throw new InternalServerErrorException('BACKUP_TOKEN_ENCRYPTION_KEY is required in production');
      }
      return null;
    }

    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length === 32) return decoded;
    if (configured.length >= 32) return createHash('sha256').update(configured).digest();

    throw new InternalServerErrorException('BACKUP_TOKEN_ENCRYPTION_KEY must be at least 32 characters or 32 base64 bytes');
  }
}
