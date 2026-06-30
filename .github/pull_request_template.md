## Summary

- Linked issue:
- Description:

## Checklist

- [ ] I have permission to submit this work and acknowledge the contribution terms in `CONTRIBUTING.md`.
- [ ] I have not included secrets, customer data, or private deployment config.
- [ ] Shared contracts in `packages/shared` were updated if events, DTOs, or schema changed.
- [ ] Realtime changes update the shared event types, server emit path, and frontend consumer.
- [ ] Schema changes include the generated Drizzle migration.
- [ ] Email template changes include regenerated files from `pnpm email:preview`.

## Testing

- [ ] `pnpm lint`
- [ ] `pnpm test:api`
- [ ] `pnpm --filter @kanera/web test`
- [ ] Other:
