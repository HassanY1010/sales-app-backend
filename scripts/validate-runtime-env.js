const required = ['DATABASE_URL', 'JWT_SECRET'];

if (process.env.NODE_ENV === 'production') {
  required.push('CORS_ORIGINS');
}

const missing = required.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');
const invalid = [];

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  invalid.push('JWT_SECRET must be at least 32 characters.');
}

if (process.env.NODE_ENV === 'production') {
  const origins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    invalid.push('CORS_ORIGINS must contain at least one trusted origin in production.');
  }

  if (origins.some((origin) => origin === '*')) {
    invalid.push('CORS_ORIGINS must not contain "*". Use explicit HTTPS origins.');
  }
}

if (missing.length || invalid.length) {
  console.error('Runtime environment validation failed:');
  for (const key of missing) console.error(`- Missing ${key}`);
  for (const message of invalid) console.error(`- ${message}`);
  console.error('Set these values in Render > Service > Environment, then redeploy.');
  process.exit(1);
}

console.log('Runtime environment validation passed.');
