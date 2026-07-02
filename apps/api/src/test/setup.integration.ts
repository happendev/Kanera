process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://kanera_test:kanera_test@localhost:55433/kanera_test";
process.env.REDIS_URL ??= "redis://localhost:56379/0";
process.env.JWT_SECRET = "test-jwt-secret-with-enough-length";
process.env.MEDIA_SIGNING_SECRET = "test-media-secret-with-at-least-thirty-two-chars";
process.env.API_PUBLIC_URL = "http://api.test";
process.env.WEB_ORIGIN = "http://web.test";
process.env.UPLOADS_DIR ??= ".tmp/test-uploads";
// Existing fixtures sign up directly without a verification code; the dedicated
// email-verification.itest.ts flips env.EMAIL_VERIFICATION_ENABLED on per-test.
process.env.EMAIL_VERIFICATION_ENABLED = "false";
