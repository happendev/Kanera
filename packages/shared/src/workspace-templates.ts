import type { ColorToken } from "./lib/colors.js";

export type WorkspaceTemplateId =
  | "development-team"
  | "marketing"
  | "simple-todo"
  | "product-team"
  | "sales-crm"
  | "operations-support"
  | "blank";

export type WorkspaceTemplateCustomField = {
  name: string;
  icon: string;
  type: "text" | "number" | "checkbox" | "select" | "date" | "url" | "user";
  allowMultiple?: boolean;
  options?: { label: string; color?: ColorToken | null }[];
};

export type WorkspaceTemplateLabel = {
  name: string;
  color: ColorToken;
};

export type WorkspaceTemplate = {
  id: WorkspaceTemplateId;
  name: string;
  description: string;
  icon: string;
  workspaceName: string;
  initialBoardName: string;
  lists: { name: string; icon: string }[];
  customFields: WorkspaceTemplateCustomField[];
  labels: WorkspaceTemplateLabel[];
};

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "development-team",
    name: "Development Team",
    description: "Plan product work, bugs, QA handoffs, and releases for an engineering team.",
    icon: "code",
    workspaceName: "Development",
    initialBoardName: "Engineering",
    lists: [
      { name: "Wishlist", icon: "star" },
      { name: "Planning / Review", icon: "clipboard-list" },
      { name: "Backlog", icon: "list" },
      { name: "Bugs / Issues / Feedback", icon: "bug" },
      { name: "Awaiting Feedback", icon: "message-dots" },
      { name: "In Progress", icon: "progress" },
      { name: "Ready for QA", icon: "checklist" },
      { name: "Complete", icon: "circle-check" },
    ],
    customFields: [
      { name: "Branch", icon: "git-branch", type: "text" },
      { name: "Billing Hours", icon: "clock-hour-4", type: "number" },
      { name: "Billing Month", icon: "calendar-month", type: "text" },
    ],
    labels: [
      { name: "Support", color: "yellow" },
      { name: "Reporting", color: "orange" },
      { name: "Issue / Bug", color: "red" },
      { name: "Chore", color: "purple" },
      { name: "Feature / Enhancement", color: "blue" },
    ],
  },
  {
    id: "marketing",
    name: "Marketing",
    description: "Coordinate campaigns, creative production, publishing, approvals, and launch reporting.",
    icon: "speakerphone",
    workspaceName: "Marketing",
    initialBoardName: "Campaigns",
    lists: [
      { name: "Ideas", icon: "bulb" },
      { name: "Briefing", icon: "clipboard" },
      { name: "Copy / Creative", icon: "pencil" },
      { name: "Review", icon: "eye" },
      { name: "Scheduled", icon: "calendar-event" },
      { name: "Live", icon: "broadcast" },
      { name: "Reporting", icon: "chart-bar" },
    ],
    customFields: [
      {
        name: "Channel",
        icon: "broadcast",
        type: "select",
        options: [
          { label: "Social", color: "sky" },
          { label: "Email", color: "violet" },
          { label: "Paid", color: "orange" },
          { label: "Content", color: "green" },
          { label: "Event", color: "rose" },
        ],
      },
      { name: "Campaign", icon: "ad", type: "text" },
      { name: "Launch Date", icon: "calendar-event", type: "date" },
      { name: "Budget", icon: "cash", type: "number" },
      { name: "Asset URL", icon: "link", type: "url" },
      { name: "Approved", icon: "checkbox", type: "checkbox" },
    ],
    labels: [
      { name: "Campaign", color: "blue" },
      { name: "Social", color: "sky" },
      { name: "Email", color: "violet" },
      { name: "Content", color: "green" },
      { name: "Paid", color: "orange" },
      { name: "Event", color: "rose" },
    ],
  },
  {
    id: "simple-todo",
    name: "Simple Todo",
    description: "A lightweight workflow for personal work, small teams, admin tasks, and quick follow-ups.",
    icon: "list-check",
    workspaceName: "Todo",
    initialBoardName: "My Tasks",
    lists: [
      { name: "To Do", icon: "circle" },
      { name: "Doing", icon: "progress" },
      { name: "Waiting", icon: "clock-pause" },
      { name: "Done", icon: "circle-check" },
    ],
    customFields: [
      {
        name: "Priority",
        icon: "flag",
        type: "select",
        options: [
          { label: "High", color: "red" },
          { label: "Medium", color: "amber" },
          { label: "Low", color: "green" },
        ],
      },
      { name: "Due Date", icon: "calendar-due", type: "date" },
      { name: "Blocked", icon: "alert-triangle", type: "checkbox" },
    ],
    labels: [
      { name: "Personal", color: "sky" },
      { name: "Admin", color: "gray" },
      { name: "Follow-up", color: "amber" },
      { name: "Quick Win", color: "green" },
    ],
  },
  {
    id: "product-team",
    name: "Product Team",
    description: "Shape ideas through discovery, design, delivery, validation, and release decisions.",
    icon: "chart-dots",
    workspaceName: "Product",
    initialBoardName: "Roadmap",
    lists: [
      { name: "Ideas", icon: "bulb" },
      { name: "Discovery", icon: "compass" },
      { name: "Spec Ready", icon: "file-check" },
      { name: "Design", icon: "palette" },
      { name: "Build", icon: "hammer" },
      { name: "Validation", icon: "circle-check" },
      { name: "Shipped", icon: "rocket" },
    ],
    customFields: [
      {
        name: "Impact",
        icon: "chart-bar",
        type: "select",
        options: [
          { label: "High", color: "green" },
          { label: "Medium", color: "amber" },
          { label: "Low", color: "gray" },
        ],
      },
      {
        name: "Effort",
        icon: "timeline",
        type: "select",
        options: [
          { label: "Small", color: "green" },
          { label: "Medium", color: "amber" },
          { label: "Large", color: "red" },
        ],
      },
      { name: "Target Release", icon: "calendar-stats", type: "date" },
      { name: "Customer Request", icon: "users", type: "checkbox" },
      { name: "Product Owner", icon: "user", type: "user" },
    ],
    labels: [
      { name: "Roadmap", color: "blue" },
      { name: "UX", color: "purple" },
      { name: "Research", color: "teal" },
      { name: "Experiment", color: "orange" },
      { name: "Customer", color: "rose" },
    ],
  },
  {
    id: "sales-crm",
    name: "Sales CRM",
    description: "Track opportunities from lead intake through proposals, negotiation, and closed outcomes.",
    icon: "briefcase",
    workspaceName: "Sales",
    initialBoardName: "Pipeline",
    lists: [
      { name: "Leads", icon: "user-plus" },
      { name: "Qualified", icon: "user-check" },
      { name: "Proposal", icon: "file-description" },
      { name: "Negotiation", icon: "message-dollar" },
      { name: "Won", icon: "trophy" },
      { name: "Lost", icon: "circle-x" },
      { name: "Follow-up", icon: "refresh" },
    ],
    customFields: [
      { name: "Deal Value", icon: "currency-dollar", type: "number" },
      { name: "Close Date", icon: "calendar-dollar", type: "date" },
      {
        name: "Stage Confidence",
        icon: "chart-funnel",
        type: "select",
        options: [
          { label: "High", color: "green" },
          { label: "Medium", color: "amber" },
          { label: "Low", color: "red" },
        ],
      },
      { name: "Account Owner", icon: "user", type: "user" },
      {
        name: "Source",
        icon: "radar",
        type: "select",
        options: [
          { label: "Inbound", color: "sky" },
          { label: "Outbound", color: "violet" },
          { label: "Referral", color: "green" },
          { label: "Partner", color: "orange" },
        ],
      },
    ],
    labels: [
      { name: "New Business", color: "blue" },
      { name: "Renewal", color: "green" },
      { name: "Expansion", color: "violet" },
      { name: "At Risk", color: "red" },
      { name: "Partner", color: "orange" },
    ],
  },
  {
    id: "operations-support",
    name: "Operations / Support",
    description: "Manage intake, triage, escalations, SLAs, internal requests, and customer resolutions.",
    icon: "headset",
    workspaceName: "Operations",
    initialBoardName: "Support Queue",
    lists: [
      { name: "Intake", icon: "inbox" },
      { name: "Triage", icon: "route" },
      { name: "Assigned", icon: "user-check" },
      { name: "Waiting", icon: "clock-pause" },
      { name: "Escalated", icon: "urgent" },
      { name: "Resolved", icon: "circle-check" },
      { name: "Closed", icon: "archive" },
    ],
    customFields: [
      {
        name: "Severity",
        icon: "alert-triangle",
        type: "select",
        options: [
          { label: "Critical", color: "red" },
          { label: "High", color: "orange" },
          { label: "Medium", color: "amber" },
          { label: "Low", color: "green" },
        ],
      },
      {
        name: "Request Type",
        icon: "clipboard-list",
        type: "select",
        options: [
          { label: "Incident", color: "red" },
          { label: "Request", color: "blue" },
          { label: "Question", color: "sky" },
          { label: "Maintenance", color: "gray" },
        ],
      },
      { name: "SLA Date", icon: "calendar-time", type: "date" },
      { name: "Customer", icon: "building-store", type: "text" },
      { name: "Escalated", icon: "urgent", type: "checkbox" },
    ],
    labels: [
      { name: "Incident", color: "red" },
      { name: "Request", color: "blue" },
      { name: "Internal", color: "gray" },
      { name: "Customer", color: "teal" },
      { name: "Compliance", color: "purple" },
    ],
  },
  {
    id: "blank",
    name: "Blank",
    description: "Start empty and add only the workflow and setup you need later.",
    icon: "layout-kanban",
    workspaceName: "Workspace",
    initialBoardName: "Board",
    lists: [],
    customFields: [],
    labels: [],
  },
];

export const DEFAULT_WORKSPACE_TEMPLATE = WORKSPACE_TEMPLATES[0]!;
