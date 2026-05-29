const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'CORS_ORIGINS',
  'GOOGLE_DRIVE_CLIENT_ID',
  'GOOGLE_DRIVE_CLIENT_SECRET',
  'GOOGLE_DRIVE_REDIRECT_URI',
  'FCM_PROJECT_ID',
  'FCM_CLIENT_EMAIL',
  'FCM_PRIVATE_KEY',
  'BACKUP_TOKEN_ENCRYPTION_KEY',
];

const missing = required.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');
const weak = [];

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  weak.push('JWT_SECRET must be at least 32 characters');
}

if (process.env.CORS_ORIGINS && process.env.CORS_ORIGINS.includes('*')) {
  weak.push('CORS_ORIGINS must not contain wildcard origins');
}

if (process.env.FCM_PRIVATE_KEY && !process.env.FCM_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
  weak.push('FCM_PRIVATE_KEY must be a real Firebase service-account private key');
}

if (process.env.BACKUP_TOKEN_ENCRYPTION_KEY) {
  const decoded = Buffer.from(process.env.BACKUP_TOKEN_ENCRYPTION_KEY, 'base64');
  if (decoded.length !== 32 && process.env.BACKUP_TOKEN_ENCRYPTION_KEY.length < 32) {
    weak.push('BACKUP_TOKEN_ENCRYPTION_KEY must be at least 32 characters or 32 base64 bytes');
  }
}

if (missing.length || weak.length) {
  console.error('Production environment validation failed.');
  for (const key of missing) console.error(`- Missing: ${key}`);
  for (const issue of weak) console.error(`- Invalid: ${issue}`);
  process.exit(1);
}

console.log('Production environment validation passed.');
