/**
 * The anchor helpers now live with the shared priority-queue component, since the shell drawer and
 * Home's block need them too. Re-exported here so the Global Work page and the Team Cards lanes
 * keep their existing import path.
 */
export { priorityAnchorAt, type PriorityAnchor } from "../../shared/priority-queue/priority-queue-math";
