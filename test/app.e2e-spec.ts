import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { DueRemindersService } from './../src/due-reminders/due-reminders.service';
import { NotificationsService } from './../src/notifications/notifications.service';

describe('Application smoke and auth boundaries (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET || 'test-secret-with-at-least-32-characters';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        $connect: jest.fn(),
        $disconnect: jest.fn(),
      })
      .overrideProvider(DueRemindersService)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
        processDueReminders: jest.fn(),
      })
      .overrideProvider(NotificationsService)
      .useValue({
        notifyUser: jest.fn(),
        notifyBusiness: jest.fn(),
        notifyAdmins: jest.fn(),
        sendPushNotification: jest.fn(),
        getUserNotifications: jest.fn(),
        markAsRead: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('serves the root smoke endpoint', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('serves health without exposing database internals on success', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      database: 'connected',
    });
    expect(response.body.timestamp).toBeTruthy();
  });

  it('blocks protected report endpoints without authentication', () => {
    return request(app.getHttpServer()).get('/reports/summary').expect(401);
  });
});
