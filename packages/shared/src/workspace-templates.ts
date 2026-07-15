import type { ColorToken } from "./lib/colors.js";

export type WorkspaceTemplateId =
  | "development-team"
  | "marketing"
  | "simple-todo"
  | "product-team"
  | "sales-crm"
  | "operations-support"
  | "project-delivery"
  | "event-planning"
  | "client-onboarding"
  | "hiring-pipeline"
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

export type WorkspaceTemplateChecklist = {
  title: string;
  items: string[];
};

export type WorkspaceTemplateCard = {
  title: string;
  description?: string;
  listName: string;
  labelNames?: string[];
  checklistTemplateTitles?: string[];
};

export type WorkspaceTemplateAutomationTrigger =
  | { type: "card_enters_list"; listName: string; applyOnCreate?: boolean; applyOnMove?: boolean }
  | { type: "due_date_arrives" }
  | { type: "all_checklist_items_complete" }
  | { type: "card_marked_complete" }
  | { type: "card_label_set"; labelName: string };

export type WorkspaceTemplateAutomationAction =
  | { type: "add_labels" | "remove_labels"; labelNames: string[] }
  | { type: "apply_checklists"; checklistTemplateTitles: string[] }
  | { type: "set_due_date"; offsetDays: number; slot?: "anyTime" | "morning" | "afternoon" | "endOfWorkDay" }
  | { type: "clear_due_date" | "move_to_top" | "move_to_bottom" }
  | { type: "set_completion"; completed: boolean }
  | { type: "move_to_list"; listName: string; placement?: "top" | "bottom" }
  | {
      type: "populate_custom_field";
      fieldName: string;
      onlyIfEmpty?: boolean;
      value:
        | { kind: "text"; text: string }
        | { kind: "text_current_date"; format: "date" | "month" | "month_long_short_year" | "month_long_year" | "datetime" }
        | { kind: "number"; number: number }
        | { kind: "date"; source: "fixed"; date: string }
        | { kind: "date"; source: "current" }
        | { kind: "checkbox"; checked: boolean }
        | { kind: "select"; optionLabels: string[] };
    };

export type WorkspaceTemplateAutomation = {
  trigger: WorkspaceTemplateAutomationTrigger;
  actions: WorkspaceTemplateAutomationAction[];
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
  checklistTemplates?: WorkspaceTemplateChecklist[];
  cards?: WorkspaceTemplateCard[];
  automations?: WorkspaceTemplateAutomation[];
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
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Bugs / Issues / Feedback" },
        actions: [{ type: "add_labels", labelNames: ["Issue / Bug"] }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Complete" },
        actions: [
          { type: "set_completion", completed: true },
          {
            type: "populate_custom_field",
            fieldName: "Billing Month",
            onlyIfEmpty: true,
            value: { kind: "text_current_date", format: "month" },
          },
        ],
      },
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
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Done" },
        actions: [{ type: "set_completion", completed: true }],
      },
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
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Shipped" },
        actions: [{ type: "set_completion", completed: true }],
      },
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
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Won" },
        actions: [{ type: "set_completion", completed: true }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Lost" },
        actions: [{ type: "set_completion", completed: true }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Follow-up" },
        actions: [{ type: "add_labels", labelNames: ["At Risk"] }],
      },
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
    automations: [
      {
        trigger: { type: "due_date_arrives" },
        actions: [{ type: "move_to_list", listName: "Escalated", placement: "top" }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Closed" },
        actions: [{ type: "set_completion", completed: true }],
      },
    ],
  },
  {
    id: "project-delivery",
    name: "Project Delivery",
    description: "Plan and deliver a finite project with clear ownership, reviews, risks, and handoff.",
    icon: "clipboard-check",
    workspaceName: "Project Delivery",
    initialBoardName: "Delivery Plan",
    lists: [
      { name: "Backlog", icon: "list" },
      { name: "Planned", icon: "calendar-event" },
      { name: "In Progress", icon: "progress" },
      { name: "Blocked", icon: "alert-triangle" },
      { name: "Review", icon: "eye" },
      { name: "Done", icon: "circle-check" },
    ],
    customFields: [
      { name: "Project Lead", icon: "user", type: "user" },
      {
        name: "Workstream",
        icon: "category",
        type: "select",
        options: [
          { label: "Planning", color: "blue" },
          { label: "Delivery", color: "violet" },
          { label: "Quality", color: "teal" },
          { label: "Handoff", color: "orange" },
        ],
      },
      { name: "Target Date", icon: "calendar-due", type: "date" },
      { name: "Estimate", icon: "clock", type: "number" },
    ],
    labels: [
      { name: "Deliverable", color: "blue" },
      { name: "Decision", color: "violet" },
      { name: "Risk", color: "red" },
      { name: "Change Request", color: "orange" },
    ],
    checklistTemplates: [
      {
        title: "Project kickoff",
        items: [
          "Confirm the goal and success criteria",
          "Agree the scope and exclusions",
          "Identify owners and stakeholders",
          "Set milestones and communication cadence",
        ],
      },
      {
        title: "Delivery review",
        items: [
          "Validate the acceptance criteria",
          "Complete quality checks",
          "Update documentation and handoff notes",
          "Capture stakeholder approval",
        ],
      },
    ],
    cards: [
      {
        title: "Confirm scope and success criteria",
        description: "Align everyone on the outcome, boundaries, and evidence that will show the project is complete.",
        listName: "Planned",
        labelNames: ["Deliverable", "Decision"],
        checklistTemplateTitles: ["Project kickoff"],
      },
      {
        title: "Build the delivery plan",
        description: "Break the work into milestones, identify owners, and record the important dependencies.",
        listName: "Planned",
        labelNames: ["Deliverable"],
      },
      {
        title: "Review risks and dependencies",
        description: "Record the risks most likely to affect scope, timing, quality, or handoff and decide how to manage them.",
        listName: "Backlog",
        labelNames: ["Risk", "Decision"],
      },
      {
        title: "Prepare the stakeholder review",
        description: "Bring together the completed work, open decisions, and evidence needed for sign-off.",
        listName: "Review",
        labelNames: ["Deliverable"],
        checklistTemplateTitles: ["Delivery review"],
      },
    ],
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Blocked" },
        actions: [{ type: "add_labels", labelNames: ["Risk"] }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Review" },
        actions: [{ type: "apply_checklists", checklistTemplateTitles: ["Delivery review"] }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Done" },
        actions: [{ type: "set_completion", completed: true }],
      },
    ],
  },
  {
    id: "event-planning",
    name: "Event Planning",
    description: "Coordinate an event from its first brief through suppliers, final readiness, and follow-up.",
    icon: "calendar-event",
    workspaceName: "Events",
    initialBoardName: "Event Plan",
    lists: [
      { name: "Ideas", icon: "bulb" },
      { name: "Planning", icon: "clipboard-list" },
      { name: "Booked", icon: "building-store" },
      { name: "In Progress", icon: "progress" },
      { name: "Ready", icon: "checklist" },
      { name: "Event Day", icon: "calendar-event" },
      { name: "Complete", icon: "circle-check" },
    ],
    customFields: [
      { name: "Event Date", icon: "calendar-event", type: "date" },
      { name: "Owner", icon: "user", type: "user" },
      { name: "Vendor", icon: "building-store", type: "text" },
      { name: "Budget", icon: "cash", type: "number" },
      {
        name: "Workstream",
        icon: "category",
        type: "select",
        options: [
          { label: "Venue", color: "blue" },
          { label: "Programme", color: "violet" },
          { label: "Promotion", color: "rose" },
          { label: "Logistics", color: "orange" },
        ],
      },
    ],
    labels: [
      { name: "Venue", color: "blue" },
      { name: "Content", color: "violet" },
      { name: "Promotion", color: "rose" },
      { name: "Logistics", color: "orange" },
      { name: "Sponsors", color: "green" },
    ],
    checklistTemplates: [
      {
        title: "Event brief",
        items: [
          "Define the audience and event goal",
          "Confirm the format, date, and capacity",
          "Set the budget and approval owner",
          "Agree how success will be measured",
        ],
      },
      {
        title: "Event-day readiness",
        items: [
          "Confirm the venue and supplier arrival times",
          "Share the final run of show",
          "Test equipment and presentation materials",
          "Confirm attendee communications",
          "Assign day-of contacts and escalation owners",
        ],
      },
    ],
    cards: [
      {
        title: "Write the event brief",
        description: "Capture the audience, purpose, format, budget, and measures of success before booking begins.",
        listName: "Planning",
        labelNames: ["Content"],
        checklistTemplateTitles: ["Event brief"],
      },
      {
        title: "Confirm venue and key suppliers",
        description: "Compare options, confirm availability and costs, and keep contracts or booking links attached here.",
        listName: "Planning",
        labelNames: ["Venue", "Logistics"],
      },
      {
        title: "Build the run of show",
        description: "Create the event timeline with owners, transitions, speaker cues, and contingency notes.",
        listName: "In Progress",
        labelNames: ["Content", "Logistics"],
      },
      {
        title: "Complete the final readiness check",
        description: "Use this as the final cross-team check before the event moves to Event Day.",
        listName: "Ready",
        labelNames: ["Logistics"],
        checklistTemplateTitles: ["Event-day readiness"],
      },
    ],
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Ready" },
        actions: [{ type: "apply_checklists", checklistTemplateTitles: ["Event-day readiness"] }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Complete" },
        actions: [{ type: "set_completion", completed: true }],
      },
    ],
  },
  {
    id: "client-onboarding",
    name: "Client Onboarding",
    description: "Move a new client from internal handoff through setup, training, go-live, and follow-up.",
    icon: "user-check",
    workspaceName: "Client Onboarding",
    initialBoardName: "Onboarding",
    lists: [
      { name: "Internal Prep", icon: "clipboard" },
      { name: "Kickoff", icon: "presentation" },
      { name: "Setup", icon: "settings" },
      { name: "Training", icon: "school" },
      { name: "Go Live", icon: "rocket" },
      { name: "Follow-up", icon: "message-circle" },
      { name: "Complete", icon: "circle-check" },
    ],
    customFields: [
      { name: "Client", icon: "building", type: "text" },
      { name: "Account Owner", icon: "user", type: "user" },
      { name: "Go-live Date", icon: "calendar-event", type: "date" },
      {
        name: "Health",
        icon: "heart-rate-monitor",
        type: "select",
        options: [
          { label: "On Track", color: "green" },
          { label: "Needs Attention", color: "amber" },
          { label: "At Risk", color: "red" },
        ],
      },
      { name: "Contract URL", icon: "link", type: "url" },
    ],
    labels: [
      { name: "Access", color: "blue" },
      { name: "Data", color: "violet" },
      { name: "Training", color: "teal" },
      { name: "Billing", color: "orange" },
      { name: "Blocked", color: "red" },
    ],
    checklistTemplates: [
      {
        title: "Client kickoff",
        items: [
          "Confirm goals and success measures",
          "Introduce the delivery team and owners",
          "Agree the timeline and communication cadence",
          "Confirm required access, data, and dependencies",
        ],
      },
      {
        title: "Go-live readiness",
        items: [
          "Complete configuration and data checks",
          "Confirm user access and permissions",
          "Deliver training and support guidance",
          "Agree the go-live owner and escalation path",
          "Schedule the post-launch check-in",
        ],
      },
    ],
    cards: [
      {
        title: "Prepare the client handoff",
        description: "Bring together the signed scope, client contacts, goals, commitments, and open sales questions.",
        listName: "Internal Prep",
        labelNames: ["Access", "Billing"],
      },
      {
        title: "Run the client kickoff",
        description: "Align the client and internal team on outcomes, responsibilities, timing, and next steps.",
        listName: "Kickoff",
        labelNames: ["Training"],
        checklistTemplateTitles: ["Client kickoff"],
      },
      {
        title: "Configure access and data",
        description: "Track accounts, permissions, source data, imports, and any client-side dependencies needed for setup.",
        listName: "Setup",
        labelNames: ["Access", "Data"],
      },
      {
        title: "Confirm go-live readiness",
        description: "Complete the final configuration, enablement, support, and ownership checks before launch.",
        listName: "Go Live",
        labelNames: ["Access", "Training"],
        checklistTemplateTitles: ["Go-live readiness"],
      },
    ],
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Kickoff" },
        actions: [{ type: "apply_checklists", checklistTemplateTitles: ["Client kickoff"] }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Go Live" },
        actions: [{ type: "apply_checklists", checklistTemplateTitles: ["Go-live readiness"] }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Complete" },
        actions: [{ type: "set_completion", completed: true }],
      },
    ],
  },
  {
    id: "hiring-pipeline",
    name: "Hiring Pipeline",
    description: "Manage candidates consistently from application and interviews through offers and onboarding.",
    icon: "user-search",
    workspaceName: "Hiring",
    initialBoardName: "Candidates",
    lists: [
      { name: "Applied", icon: "inbox" },
      { name: "Screening", icon: "phone" },
      { name: "Interview", icon: "calendar-event" },
      { name: "Decision", icon: "scale" },
      { name: "Offer", icon: "file-description" },
      { name: "Hired", icon: "user-check" },
      { name: "Rejected", icon: "user-x" },
    ],
    customFields: [
      { name: "Role", icon: "briefcase", type: "text" },
      {
        name: "Source",
        icon: "radar",
        type: "select",
        options: [
          { label: "Direct", color: "blue" },
          { label: "Referral", color: "green" },
          { label: "Agency", color: "orange" },
          { label: "Job Board", color: "violet" },
        ],
      },
      { name: "Interview Date", icon: "calendar-event", type: "date" },
      { name: "Hiring Manager", icon: "user", type: "user" },
      { name: "Score", icon: "star", type: "number" },
    ],
    labels: [
      { name: "Priority", color: "red" },
      { name: "Referral", color: "green" },
      { name: "Remote", color: "blue" },
      { name: "Follow-up", color: "amber" },
    ],
    checklistTemplates: [
      {
        title: "Candidate interview",
        items: [
          "Confirm the interview panel and focus areas",
          "Share the candidate brief with interviewers",
          "Collect independent feedback",
          "Hold the hiring decision review",
          "Communicate the next step to the candidate",
        ],
      },
      {
        title: "New hire onboarding",
        items: [
          "Confirm the signed offer and start date",
          "Prepare accounts and equipment",
          "Share the first-week plan",
          "Assign an onboarding contact",
          "Schedule the first check-in",
        ],
      },
    ],
    // Candidate cards contain personal information, so this preset deliberately starts empty.
    cards: [],
    automations: [
      {
        trigger: { type: "card_enters_list", listName: "Interview" },
        actions: [{ type: "apply_checklists", checklistTemplateTitles: ["Candidate interview"] }],
      },
      {
        trigger: { type: "card_enters_list", listName: "Hired" },
        actions: [{ type: "apply_checklists", checklistTemplateTitles: ["New hire onboarding"] }],
      },
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
