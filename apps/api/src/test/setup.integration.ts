process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://kanera_test:kanera_test@localhost:55433/kanera_test";
process.env.REDIS_URL ??= "redis://localhost:56379/0";
process.env.JWT_SECRET = "test-jwt-secret-with-enough-length";
process.env.MFA_ENCRYPTION_KEY = "test-mfa-encryption-key-with-enough-length";
// Admin console uses a fully separate signing secret; it MUST differ from JWT_SECRET (env asserts this).
process.env.ADMIN_JWT_SECRET = "test-admin-jwt-secret-distinct-from-tenant";
process.env.MEDIA_SIGNING_SECRET = "test-media-secret-with-at-least-thirty-two-chars";
process.env.API_PUBLIC_URL = "http://api.test";
process.env.WEB_ORIGIN = "http://web.test";
process.env.UPLOADS_DIR ??= ".tmp/test-uploads";
// Existing fixtures sign up directly without a verification code; the dedicated
// email-verification.itest.ts flips env.EMAIL_VERIFICATION_ENABLED on per-test.
process.env.EMAIL_VERIFICATION_ENABLED = "false";
// Present so the env-bootstrap seed path (seedFirstAdmin) is exercisable in admin auth itests. The
// integration server builds with seedAdmin:false, so these do not auto-seed during normal test setup.
process.env.ADMIN_EMAIL = "seed-admin@test.local";
process.env.ADMIN_PASSWORD = "seed-admin-password";
