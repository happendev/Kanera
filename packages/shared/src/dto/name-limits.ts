export const GENERAL_NAME_MAX_LENGTH = 120;
// Notes are documents, so the cap is well above a card description's 50,000. It keeps a single
// autosave, its realtime echo and the generated search vector bounded.
export const NOTE_CONTENT_MAX_LENGTH = 500_000;
// A comment body's limit, shared so server-rendered comments (automation templates) honour it too.
export const COMMENT_BODY_MAX_LENGTH = 20_000;
export const API_KEY_NAME_MAX_LENGTH = 25;
export const WORKSPACE_ENTITY_NAME_MAX_LENGTH = 35;
export const CARD_LABEL_NAME_MAX_LENGTH = 25;
export const CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH = GENERAL_NAME_MAX_LENGTH;
