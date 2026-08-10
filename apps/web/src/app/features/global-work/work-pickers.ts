import type {
  SavedWorkView,
  WorkCatalog,
  WorkCatalogBoard,
  WorkCatalogPerson,
} from "@kanera/shared/dto";
import type { PickerGroup, PickerOption } from "../../shared/picker-list.component";

/**
 * Picker row builders for the global work pages. The scope, board and people dropdowns all
 * span many organisations and workspaces, so they render the sidebar's hierarchy — organisation
 * heading, workspace icon, indented boards — instead of a flat list of similar-looking names.
 *
 * Standalone ("board"-kind) workspaces are collapsed to their board, matching how the sidebar
 * presents them: the wrapper workspace is an implementation detail, not a place users navigate to.
 */

/** Scope value for "no scope filter". Kept in sync with `GlobalWorkPage.selectSource`. */
export const ALL_BOARDS_SCOPE = "";

function organisationLabel(name: string, external: boolean): string {
  return external ? `${name} · Guest` : name;
}

function boardOption(board: WorkCatalogBoard, id: string, depth: number): PickerOption {
  return {
    id,
    label: board.name,
    icon: board.icon || "layout-kanban",
    color: board.iconColor,
    depth,
  };
}

/**
 * Rows for the "All boards" scope picker. Ids carry the `o:`/`w:`/`b:` prefixes the page parses,
 * with the empty id meaning every accessible board.
 */
export function scopePickerGroups(catalog: WorkCatalog): PickerGroup[] {
  const groups: PickerGroup[] = [{
    id: "all",
    options: [{
      id: ALL_BOARDS_SCOPE,
      label: "All boards",
      icon: "world",
      hint: `${catalog.boards.length} ${catalog.boards.length === 1 ? "board" : "boards"} you can access`,
    }],
  }];

  for (const organisation of catalog.organisations) {
    const workspaces = catalog.workspaces
      .filter((workspace) => workspace.organisationId === organisation.id);
    const options: PickerOption[] = [{
      id: `o:${organisation.id}`,
      label: "Everything in this organisation",
      icon: "building",
    }];

    for (const workspace of workspaces) {
      const boards = catalog.boards.filter((board) => board.workspaceId === workspace.id);
      if (workspace.kind === "board") {
        options.push(...boards.map((board) => boardOption(board, `b:${board.id}`, 0)));
      } else {
        options.push({
          id: `w:${workspace.id}`,
          label: workspace.name,
          icon: workspace.icon || "rocket",
          color: workspace.accentColor,
          trailing: `${boards.length}`,
        });
        options.push(...boards.map((board) => boardOption(board, `b:${board.id}`, 1)));
      }
    }

    if (options.length > 1) {
      groups.push({
        id: organisation.id,
        label: organisationLabel(organisation.name, organisation.external),
        icon: "building",
        options,
      });
    }
  }

  return groups;
}

/**
 * Rows for choosing a single board (card creation). Grouped by workspace so two boards with the
 * same name in different workspaces are still tellable apart.
 */
export function boardPickerGroups(catalog: WorkCatalog, boards: WorkCatalogBoard[]): PickerGroup[] {
  const multiOrganisation = catalog.organisations.length > 1;
  const groups: PickerGroup[] = [];

  // Organisation first, then workspace, so the sections never interleave organisations.
  for (const organisation of catalog.organisations) {
    const organisationName = organisationLabel(organisation.name, organisation.external);
    const workspaces = catalog.workspaces
      .filter((workspace) => workspace.organisationId === organisation.id);

    for (const workspace of workspaces.filter((workspace) => workspace.kind !== "board")) {
      const workspaceBoards = boards.filter((board) => board.workspaceId === workspace.id);
      if (workspaceBoards.length === 0) continue;
      groups.push({
        id: workspace.id,
        label: multiOrganisation ? `${organisationName} · ${workspace.name}` : workspace.name,
        icon: workspace.icon || "rocket",
        color: workspace.accentColor,
        options: workspaceBoards.map((board) => boardOption(board, board.id, 0)),
      });
    }

    // A standalone board is its own workspace, so a workspace heading would just repeat the board
    // name; those boards are filed under the organisation instead.
    const standaloneBoards = workspaces
      .filter((workspace) => workspace.kind === "board")
      .flatMap((workspace) => boards.filter((board) => board.workspaceId === workspace.id));
    if (standaloneBoards.length) {
      groups.push({
        id: `standalone:${organisation.id}`,
        label: organisationName,
        icon: "building",
        options: standaloneBoards.map((board) => boardOption(board, board.id, 0)),
      });
    }
  }

  return groups;
}

/**
 * Rows for picking a person. `allOption` prepends an "everyone" row; people are grouped by
 * organisation only when guests from other organisations are in play.
 */
export function peoplePickerGroups(
  people: WorkCatalogPerson[],
  catalog: WorkCatalog,
  allOption?: { id: string; label: string },
): PickerGroup[] {
  const groups: PickerGroup[] = allOption
    ? [{ id: "all", options: [{ id: allOption.id, label: allOption.label, icon: "users" }] }]
    : [];
  const organisationsById = new Map(catalog.organisations.map((item) => [item.id, item]));
  const visibleOrganisationIds = new Set(people.map((person) => person.organisationId));
  const organisationIds = [
    ...catalog.organisations
      .map((organisation) => organisation.id)
      .filter((organisationId) => visibleOrganisationIds.has(organisationId)),
    ...[...visibleOrganisationIds].filter((organisationId) =>
      !catalog.organisations.some((organisation) => organisation.id === organisationId)
    ),
  ];
  const multiOrganisation = organisationIds.length > 1;

  const personOption = (person: WorkCatalogPerson): PickerOption => ({
    id: person.userId,
    label: person.displayName,
    avatarName: person.displayName,
    avatarUrl: person.avatarUrl,
    avatarUserId: person.userId,
  });

  if (!multiOrganisation) {
    groups.push({ id: "people", options: [...people].sort((a, b) => a.displayName.localeCompare(b.displayName)).map(personOption) });
    return groups;
  }

  for (const organisationId of organisationIds) {
    const organisation = organisationsById.get(organisationId);
    groups.push({
      id: organisationId,
      label: organisation ? organisationLabel(organisation.name, organisation.external) : "Other organisation",
      icon: "building",
      options: people
        .filter((person) => person.organisationId === organisationId)
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map(personOption),
    });
  }
  return groups;
}

/** Rows for the saved-view picker, split into views you own and views shared with you. */
export function savedViewPickerGroups(views: SavedWorkView[]): PickerGroup[] {
  const mine = views.filter((view) => view.editable);
  const shared = views.filter((view) => !view.editable);
  const groups: PickerGroup[] = [{
    id: "none",
    options: [{ id: "", label: "No saved view", icon: "circle-off" }],
  }];
  if (mine.length) {
    groups.push({
      id: "mine",
      label: "Your views",
      options: mine.map((view) => ({
        id: view.id,
        label: view.name,
        icon: view.visibility === "organisation" ? "users" : "lock",
      })),
    });
  }
  if (shared.length) {
    groups.push({
      id: "shared",
      label: "Shared with you",
      options: shared.map((view) => ({
        id: view.id,
        label: view.name,
        icon: "share",
        hint: view.ownerName,
      })),
    });
  }
  return groups;
}
