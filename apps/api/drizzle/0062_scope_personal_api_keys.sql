-- Personal keys were created before scope applied to them and all sit at the column default
-- 'read'. They have always behaved as read-write; pin that so enabling enforcement is a no-op
-- for every credential already in the field.
UPDATE "workspace_api_key" SET "scope" = 'write' WHERE "kind" = 'personal';
