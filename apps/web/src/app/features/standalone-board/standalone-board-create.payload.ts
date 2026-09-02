// The payload builders live in @kanera/shared so MCP/CLI bootstrap tools and the web app seed
// identical requests. This module keeps the historical import path for the web consumers.
export { standaloneBoardCreatePayload, workspaceTemplateSeedPayload } from "@kanera/shared/workspace-template-payload";
